import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Router } from "express";
import { z } from "zod";
import { actorOf, orgOf, requirePermission } from "../auth/middleware.js";
import { registry } from "../integrations/registry.js";
import { HttpError } from "../lib/errors.js";
import { param, parse } from "../lib/validate.js";
import { runCheck } from "../monitoring/checkService.js";
import { notifier } from "../notifications/notifier.js";
import { audit } from "../services/auditService.js";
import { cameraReportCsv } from "../services/cameraReportService.js";
import {
  resetPictureReference,
  cameraInputSchema,
  cameraUpdateSchema,
  createCamera,
  getCamera,
  getCameraRow,
  setMaintenance,
  getHistory,
  getSummary,
  listCameras,
  listLocations,
  listQuerySchema,
  removeCameras,
  listCameraIds,
  setLocalStorage,
  setPriority,
  setMonitoring,
  updateCamera,
} from "../services/cameraService.js";
import { testCameraConfig, testSavedCamera } from "../services/connectionService.js";
import { uptimeCsv, uptimeReport } from "../services/uptimeService.js";
import { commitImport, csvTemplate, importRequestSchema, publicValidation, validateImport } from "../services/importService.js";
import { getSnapshot } from "../services/liveViewService.js";
import { scanNetwork, scanRequestSchema } from "../services/networkScanService.js";
import { pingCamera } from "../services/pingService.js";
import { listCameraEvents } from "../services/cameraEventService.js";
import { firmwareCameras, firmwareCamerasQuery, firmwareCsv, firmwareInventory } from "../services/firmwareService.js";
import { fetchCameraCertificate } from "../services/tlsCertificate.js";
import { CLIP_MAX_SECONDS, listRecordings, liveProblem, liveVideoEnabled, oldestRecording, playbackStreamName, preparePlayback, recordedDays, recordingClip, prepareStream } from "../services/liveVideoService.js";
import { lastRefusal, playbackDiagnosis, playbackTimings } from "../services/rtspReplayRelay.js";
import { deviceLimiter, importLimiter, liveViewLimiter } from "./limits.js";

export const camerasRouter = Router();
const read = requirePermission("cameras:read");
const write = requirePermission("cameras:write");
const check = requirePermission("cameras:check");

camerasRouter.get("/", read, async (req, res) => {
  res.json(await listCameras(orgOf(req), parse(listQuerySchema, req.query)));
});

camerasRouter.get("/report", read, async (req, res) => {
  const q = parse(listQuerySchema, req.query);
  const { timeZone } = parse(z.object({ timeZone: z.string().min(1).max(64).default("UTC") }), { timeZone: req.query.timeZone });
  const { csv, rows } = await cameraReportCsv(orgOf(req), q, timeZone);
  const filters = Object.fromEntries(
    Object.entries(q).filter(([k, v]) => !["page", "pageSize", "sort", "order"].includes(k) && v !== undefined && v !== ""),
  );
  await audit({ actor: actorOf(req), ip: req.ip, action: "camera.report_exported", entityType: "camera", details: { rows, ...filters } });
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="camera-status-report-${day}.csv"`);
  res.send(csv);
});

camerasRouter.get("/ids", read, async (req, res) => {
  res.json(await listCameraIds(orgOf(req), parse(listQuerySchema, req.query)));
});

// Uptime over the last 7, 30 or 90 days: per camera and location (the page shows the lowest 500; the CSV has all).
const uptimeQuery = z.object({ days: z.coerce.number().int().refine((d) => [1, 7, 30, 90].includes(d), "Use 1, 7, 30 or 90").default(30) });
camerasRouter.get("/uptime", read, async (req, res) => {
  const { days } = parse(uptimeQuery, req.query);
  const r = await uptimeReport(orgOf(req), days);
  res.json({ ...r, cameras: r.cameras.slice(0, 500), camerasShown: Math.min(500, r.cameras.length) });
});
camerasRouter.get("/uptime.csv", read, async (req, res) => {
  const { days } = parse(uptimeQuery, req.query);
  const r = await uptimeReport(orgOf(req), days);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="uptime-${days}-days-${r.to.slice(0, 10)}.csv"`);
  res.send(uptimeCsv(r));
});

// Firmware inventory: models and firmware versions, the cameras on an older version than the newest here.
camerasRouter.get("/firmware", read, async (req, res) => {
  res.json(await firmwareInventory(orgOf(req)));
});
camerasRouter.get("/firmware/cameras", read, async (req, res) => {
  res.json(await firmwareCameras(orgOf(req), parse(firmwareCamerasQuery, req.query)));
});
camerasRouter.get("/firmware.csv", read, async (req, res) => {
  const { csv, rows } = await firmwareCsv(orgOf(req));
  await audit({ actor: actorOf(req), ip: req.ip, action: "camera.firmware_exported", entityType: "camera", details: { rows } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="firmware-inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

camerasRouter.get("/summary", read, async (req, res) => {
  res.json(await getSummary(orgOf(req)));
});

camerasRouter.get("/locations", read, async (req, res) => {
  res.json(await listLocations(orgOf(req)));
});

camerasRouter.post("/", write, async (req, res) => {
  const input = parse(cameraInputSchema, req.body);
  const id = await createCamera(orgOf(req), input, actorOf(req), req.ip);
  res.status(201).json(await getCamera(id, orgOf(req)));
});

// Test an unsaved configuration from the Add Camera form.
camerasRouter.post("/test-connection", write, deviceLimiter, async (req, res) => {
  const input = parse(cameraInputSchema, req.body);
  res.json(await testCameraConfig(registry.get(input.brand), input));
});

camerasRouter.get("/import/template", read, (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="camera-import-template.csv"');
  res.send(csvTemplate());
});

camerasRouter.post("/import/validate", write, importLimiter, async (req, res) => {
  const { rows, options } = parse(importRequestSchema, req.body);
  const results = publicValidation(await validateImport(orgOf(req), rows, options));
  res.json({
    results,
    summary: {
      total: results.length,
      valid: results.filter((r) => r.status === "valid").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
    },
  });
});

camerasRouter.post("/import", write, importLimiter, async (req, res) => {
  const { rows, options } = parse(importRequestSchema, req.body);
  res.json(await commitImport(orgOf(req), rows, options, actorOf(req), req.ip));
});

camerasRouter.post("/bulk-delete", write, async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).min(1).max(500) }), req.body);
  res.json(await removeCameras(orgOf(req), ids, actorOf(req), req.ip));
});

camerasRouter.post("/bulk-local-storage", write, async (req, res) => {
  const { ids, localStorage } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), localStorage: z.boolean() }).strict(), req.body);
  res.json(await setLocalStorage(orgOf(req), ids, localStorage, actorOf(req), req.ip));
});

// Maintenance (planned work): Operators and Org Admins, like handling alerts. minutes: null ends it.
camerasRouter.post("/bulk-maintenance", requirePermission("alerts:manage"), async (req, res) => {
  const { ids, minutes, note } = parse(
    z.object({
      ids: z.array(z.string().uuid()).min(1).max(500),
      minutes: z.number().int().min(15).max(30 * 24 * 60).nullable(),
      note: z.string().trim().max(200).optional(),
    }).strict(),
    req.body,
  );
  res.json(await setMaintenance(orgOf(req), ids, minutes === null ? null : new Date(Date.now() + minutes * 60_000), note || null, actorOf(req), req.ip));
});

camerasRouter.post("/bulk-priority", write, async (req, res) => {
  const { ids, priority } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), priority: z.enum(["critical", "normal"]) }).strict(), req.body);
  res.json(await setPriority(orgOf(req), ids, priority, actorOf(req), req.ip));
});

// Whether smooth live video is set up (go2rtc); without it the live view shows pictures.
camerasRouter.get("/live-video", requirePermission("cameras:live"), (_req, res) => {
  res.json({ enabled: liveVideoEnabled() });
});

camerasRouter.get("/:id", read, async (req, res) => {
  res.json(await getCamera(param(req), orgOf(req)));
});

camerasRouter.patch("/:id", write, async (req, res) => {
  const patch = parse(cameraUpdateSchema, req.body);
  await updateCamera(orgOf(req), param(req), patch, actorOf(req), req.ip);
  res.json(await getCamera(param(req), orgOf(req)));
});

camerasRouter.delete("/:id", write, async (req, res) => {
  const result = await removeCameras(orgOf(req), [param(req)], actorOf(req), req.ip);
  if (result.removed.length === 0) throw new HttpError(404, "NOT_FOUND", "Camera not found");
  res.status(204).end();
});

camerasRouter.post("/:id/monitoring", write, async (req, res) => {
  const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
  await setMonitoring(orgOf(req), param(req), enabled, actorOf(req), req.ip);
  res.json(await getCamera(param(req), orgOf(req)));
});

// Test a saved camera, optionally with unsaved edits applied (blank password keeps the stored one).
// The certificate a camera presents on HTTPS, to check its fingerprint and trust it (camera form).
camerasRouter.post("/tls-certificate", write, deviceLimiter, async (req, res) => {
  const { host, port } = parse(z.object({ host: z.string().trim().min(1).max(253), port: z.coerce.number().int().min(1).max(65535).default(443) }).strict(), req.body);
  res.json(await fetchCameraCertificate(host, port));
});

camerasRouter.post("/:id/test-connection", check, deviceLimiter, async (req, res) => {
  const overrides = parse(cameraUpdateSchema, req.body ?? {});
  if (Object.keys(overrides).length > 0 && !req.auth!.user.permissions.includes("cameras:write")) {
    throw new HttpError(403, "FORBIDDEN", "Testing modified settings requires camera edit permission");
  }
  res.json(await testSavedCamera(orgOf(req), param(req), overrides));
});

camerasRouter.post("/:id/check-storage", check, deviceLimiter, async (req, res) => {
  await getCamera(param(req), orgOf(req)); // 404 for unknown cameras and other organizations' cameras
  const outcome = await runCheck(param(req), "manual", { registry, notifier });
  if (outcome.status === "busy") throw new HttpError(409, "CHECK_IN_PROGRESS", "A check for this camera is already running");
  res.json({ outcome: { result: outcome.result, attempts: outcome.attempts, durationMs: outcome.durationMs }, camera: await getCamera(param(req), orgOf(req)) });
});

// Looks for cameras in an address range (inside the allowed camera networks; no credentials sent).
camerasRouter.post("/scan", write, importLimiter, async (req, res) => {
  const { range } = parse(scanRequestSchema, req.body);
  res.json(await scanNetwork(orgOf(req), range, actorOf(req), req.ip));
});

// The camera's current view becomes its normal picture (after it was moved or refocused on purpose).
camerasRouter.post("/:id/picture/reset-reference", write, async (req, res) => {
  await resetPictureReference(orgOf(req), param(req), actorOf(req), req.ip);
  res.status(204).end();
});

// What the camera reported on its own (tampering, video loss, faults, failed logins), newest first.
camerasRouter.get("/:id/events", read, async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  res.json(await listCameraEvents(orgOf(req), param(req), limit));
});

// Ping from this server: ICMP (when allowed) and the camera's web and RTSP ports.
camerasRouter.post("/:id/ping", check, deviceLimiter, async (req, res) => {
  res.json(await pingCamera(orgOf(req), param(req)));
});

// Live video: registers the camera's stream, then the page opens /api/cameras/:id/live/ws (liveVideoProxy).
/** An NVR channel (?channel=N or "channel" in the body), for live view and recordings of one of its cameras. */
const channelOf = (raw: unknown) => parse(z.object({ channel: z.coerce.number().int().min(1).max(256).optional() }), { channel: raw ?? undefined }).channel;

// Why live video does not play: tested from the server and from go2rtc (nothing is changed).
camerasRouter.get("/:id/live/problem", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  res.json({ problem: await liveProblem(orgOf(req), param(req), channelOf(req.query.channel)) });
});

camerasRouter.post("/:id/live/prepare", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  const channel = channelOf(req.query.channel);
  await prepareStream(orgOf(req), param(req), channel);
  await audit({ actor: actorOf(req), ip: req.ip, organizationId: orgOf(req), action: "camera.live_view", entityType: "camera", entityId: param(req), details: { video: true, ...(channel ? { channel } : {}) } });
  res.json({ ok: true });
});

// Recordings on the camera's own storage: what a day holds, and playback from a time (through go2rtc).
camerasRouter.get("/:id/recordings", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  const { date } = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD") }), req.query);
  res.json(await listRecordings(orgOf(req), param(req), date, channelOf(req.query.channel)));
});
camerasRouter.get("/:id/recordings/days", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM") }), req.query);
  res.json({ month, days: await recordedDays(orgOf(req), param(req), month, channelOf(req.query.channel)) });
});
camerasRouter.get("/:id/recordings/oldest", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  res.json({ oldest: await oldestRecording(orgOf(req), param(req), channelOf(req.query.channel)) });
});
// Why the camera refused this session's playback (the relay saw its answer; go2rtc only says "wrong response").
camerasRouter.get("/:id/playback/problem", requirePermission("cameras:live"), async (req, res) => {
  await getCameraRow(param(req), orgOf(req));
  const stream = playbackStreamName(param(req), req.auth!.sessionId);
  res.json({ refusal: lastRefusal(stream) ?? null, problem: playbackDiagnosis(stream) ?? null, timings: playbackTimings(stream) ?? null });
});

camerasRouter.post("/:id/playback/prepare", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  const { start, speed, channel } = parse(
    z.object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Use YYYY-MM-DDTHH:MM:SS"),
      // Faster than normal is asked of the camera; slower is done by the browser.
      speed: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]).optional(),
      channel: z.number().int().min(1).max(256).optional(),
    }).strict(),
    req.body,
  );
  const { start: from, via } = await preparePlayback(orgOf(req), param(req), req.auth!.sessionId, start, speed, channel);
  // `via`: how the recording was opened (the playback address, or ONVIF replay), to explain a camera that misplays.
  await audit({ actor: actorOf(req), ip: req.ip, organizationId: orgOf(req), action: "camera.playback", entityType: "camera", entityId: param(req), details: { start: from, ...(speed && speed > 1 ? { speed } : {}), ...(channel ? { channel } : {}), via } });
  res.json({ ok: true, start: from });
});

// A clip of the recording as an MP4 download (evidence). The camera sends it at normal speed, so the
// download takes about as long as the clip; closing it stops the recording.
camerasRouter.get("/:id/recordings/clip", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  const { start, seconds, channel } = parse(
    z.object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Use YYYY-MM-DDTHH:MM:SS"),
      seconds: z.coerce.number().int().min(5).max(CLIP_MAX_SECONDS),
      channel: z.coerce.number().int().min(1).max(256).optional(),
    }).strict(),
    req.query,
  );
  const row = await getCameraRow(param(req), orgOf(req));
  const abort = new AbortController();
  const clip = await recordingClip(orgOf(req), param(req), start, seconds, channel, abort.signal);
  await audit({
    actor: actorOf(req), ip: req.ip, organizationId: orgOf(req), action: "camera.recording_exported", entityType: "camera", entityId: param(req),
    details: { start: clip.start, seconds, ...(channel ? { channel } : {}), via: clip.via },
  });
  const safe = (row.name as string).trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "camera";
  const file = `${safe}${channel ? `-ch${channel}` : ""}_${clip.start.replace("T", "_").replace(/:/g, "-")}_${seconds}s.mp4`;
  res.setHeader("Content-Type", clip.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.setHeader("Cache-Control", "no-store");
  const body = Readable.fromWeb(clip.body as unknown as WebReadableStream);
  const finish = () => {
    abort.abort();
    body.destroy();
    clip.done();
  };
  res.on("close", finish);
  body.on("error", () => res.destroy());
  body.pipe(res);
});

// Live view: the current picture. `start=1` on the first picture of a viewing records it in the audit log.
camerasRouter.get("/:id/snapshot", requirePermission("cameras:live"), liveViewLimiter, async (req, res) => {
  const { start } = parse(z.object({ start: z.literal("1").optional() }), req.query);
  const channel = channelOf(req.query.channel);
  const snapshot = await getSnapshot(orgOf(req), param(req), channel);
  if (start) await audit({ actor: actorOf(req), ip: req.ip, organizationId: orgOf(req), action: "camera.live_view", entityType: "camera", entityId: param(req), details: channel ? { channel } : {} });
  res.set({ "Content-Type": snapshot.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(snapshot.data);
});

camerasRouter.get("/:id/storage", read, async (req, res) => {
  const cam = await getCamera(param(req), orgOf(req));
  res.json({
    cameraId: cam.id,
    checkedAt: cam.status.lastSuccessAt,
    status: cam.status.storageHealth,
    totalBytes: cam.status.totalBytes,
    usedBytes: cam.status.usedBytes,
    freeBytes: cam.status.freeBytes,
    usedPercentage: cam.status.usedPercentage,
    devices: cam.devices,
    error: cam.status.lastErrorCode ? { code: cam.status.lastErrorCode, message: cam.status.lastErrorMessage } : undefined,
  });
});

camerasRouter.get("/:id/history", read, async (req, res) => {
  const q = parse(
    z.object({ hours: z.coerce.number().int().min(1).max(24 * 365).default(168), limit: z.coerce.number().int().min(1).max(5000).default(1000) }),
    req.query,
  );
  res.json(await getHistory(orgOf(req), param(req), q));
});
