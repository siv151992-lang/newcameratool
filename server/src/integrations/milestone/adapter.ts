import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import type { OnvifRecording, OnvifSourceChannel } from "../onvif/parser.js";
import { fetchSnapshot } from "../snapshot.js";
import {
  AUTH_ERROR_CODES,
  type BrandMeta,
  CameraApiError,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type DiagnosticStep,
  NETWORK_ERROR_CODES,
  type NvrChannel,
  type RecordingList,
  type RecordingState,
  type StorageReading,
} from "../types.js";

/**
 * Milestone XProtect, through the Milestone Open Network Bridge (Milestone's ONVIF interface to its
 * recording servers, Profiles S and G). The bridge is added once, as an NVR: each XProtect camera
 * is a channel, with live video and the recordings on the XProtect recording servers. The bridge
 * lists its cameras as media profiles (one video source each); recordings name the camera they
 * come from (their source), or else follow the cameras' order.
 *
 * XProtect keeps its own storage, so there are no disks to read: the bridge is checked for being
 * reachable and its cameras for being listed and recording.
 */
export class MilestoneAdapter extends OnvifAdapter {
  override readonly meta: BrandMeta = {
    key: "milestone",
    displayName: "Milestone XProtect (Open Network Bridge)",
    supportStatus: "unverified",
    authMethods: ["ws-security (UsernameToken digest)", "digest"],
    // The bridge's ONVIF port; video comes on its RTSP port (554).
    defaultPorts: { http: 580, https: 443 },
    capabilities: ["device-info", "connection-test", "live-view", "playback", "nvr-channels"],
    defaultTimeoutMs: 10000,
    recordsElsewhere: true,
    notes:
      "Add the Milestone Open Network Bridge once, as an NVR (port 580, a Milestone user allowed to use the bridge): " +
      "each XProtect camera is a channel, with live video and its recordings on the XProtect recording servers. " +
      "Disk health stays in XProtect.",
  };

  constructor(http: CameraHttpClient) {
    super(http);
  }

  /** The cameras the bridge lists (one per video source). */
  private async cameras(camera: CameraConfig): Promise<OnvifSourceChannel[]> {
    const list = await this.sourceChannels(camera);
    if (!list.length) throw new CameraApiError("API_UNAVAILABLE", "The Open Network Bridge lists no cameras: check that the Milestone user may see cameras in XProtect");
    return list;
  }

  private async channel(camera: CameraConfig, channel: number): Promise<OnvifSourceChannel> {
    const c = (await this.cameras(camera)).find((x) => x.channel === channel);
    if (!c) throw new CameraApiError("API_UNAVAILABLE", `The Open Network Bridge has no camera ${channel}`);
    return c;
  }

  /** No disks here (XProtect keeps its own storage): the bridge answering with its cameras is the check. */
  override async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    await this.cameras(camera);
    return { devices: [] };
  }

  async getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    const cams = await this.cameras(camera);
    const byChannel = await this.recordingsByChannel(camera, cams).catch(() => new Map<number, OnvifRecording[]>());
    return cams.map((c) => ({ channel: c.channel, name: c.name, recording: recordingState(byChannel.get(c.channel)) }));
  }

  override liveRtspUrl(camera: CameraConfig, channel?: number): Promise<string> {
    if (!channel) return super.liveRtspUrl(camera);
    return this.channel(camera, channel).then((c) => this.mediaUri(camera, "Stream", c.profileToken));
  }

  override async getSnapshot(camera: CameraConfig, channel?: number) {
    if (!channel) return super.getSnapshot(camera);
    const uri = new URL(await this.mediaUri(camera, "Snapshot", (await this.channel(camera, channel)).profileToken));
    const protocol = uri.protocol === "https:" ? "https" : "http";
    const port = uri.port ? Number(uri.port) : protocol === "https" ? 443 : 80;
    return fetchSnapshot(this.http, { ...camera, protocol, port }, `${uri.pathname}${uri.search}`);
  }

  /** One camera's recordings (Profile G), in the bridge's local time; each plays by its recording token. */
  override async listRecordings(camera: CameraConfig, fromMs?: number, toMs?: number, channel?: number): Promise<RecordingList> {
    if (!channel) return super.listRecordings(camera);
    const cams = await this.cameras(camera);
    const found = (await this.recordingsByChannel(camera, cams)).get(channel) ?? [];
    const { now, shiftMs } = await this.cameraClock(camera);
    const segments = found
      .map((r) => ({ start: r.from + shiftMs, end: Math.min(r.until, now) + shiftMs, ref: r.token }))
      .filter((s) => (fromMs === undefined || s.end > fromMs) && (toMs === undefined || s.start < toMs))
      .sort((a, b) => a.start - b.start);
    return { segments, nowMs: now + shiftMs, shiftMs };
  }

  /** Each camera's recordings: matched by source id, then by name, then by order (one recording per camera). */
  private async recordingsByChannel(camera: CameraConfig, cams: OnvifSourceChannel[]): Promise<Map<number, OnvifRecording[]>> {
    return matchRecordings(cams, await this.findRecordings(camera));
  }

  /** Reachable, signed in, and its cameras listed; there is no storage to read. */
  override async testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    const steps: DiagnosticStep[] = [];
    const step = (key: DiagnosticStep["key"], status: DiagnosticStep["status"], label: string, message: string) => steps.push({ key, label, status, message });
    let deviceInfo: DeviceInfo | undefined;
    try {
      deviceInfo = await this.getDeviceInfo(camera);
      step("reachability", "passed", "Network reachability", `Connected to ${camera.host}:${camera.port}`);
      step("authentication", "passed", "Authentication", "Signed in to the Open Network Bridge");
      const cams = await this.cameras(camera);
      step("api", "passed", "Cameras", `${cams.length} camera${cams.length === 1 ? "" : "s"}: ${cams.slice(0, 5).map((c) => c.name).join(", ")}${cams.length > 5 ? ", …" : ""}`);
      step("storage", "skipped", "Storage", "XProtect keeps its own storage; its disk health stays in XProtect");
      return { ok: true, reachable: true, steps, deviceInfo, storage: { devices: [] } };
    } catch (err) {
      const e = err instanceof CameraApiError ? err : new CameraApiError("API_ERROR", "Unexpected error");
      const reachable = !NETWORK_ERROR_CODES.has(e.code);
      if (!reachable) step("reachability", "failed", "Network reachability", e.message);
      else if (AUTH_ERROR_CODES.has(e.code)) step("authentication", "failed", "Authentication", `${e.message}. Use a Milestone user that the Open Network Bridge allows.`);
      else step("api", "failed", "Cameras", e.message);
      return { ok: false, reachable, steps, deviceInfo, error: { code: e.code, message: e.message } };
    }
  }
}

/** Recording now, stopped, or not known (no alert), from the recordings' status. */
function recordingState(recs: OnvifRecording[] | undefined): RecordingState | undefined {
  const statuses = (recs ?? []).map((r) => r.status ?? "");
  if (statuses.some((s) => /^recording$/i.test(s))) return "recording";
  if (statuses.length && statuses.every((s) => /^(stopped|removed|removing)$/i.test(s))) return "idle";
  return undefined;
}

/**
 * Which camera each recording is from: its source id is the camera's video source (or profile)
 * token, or its source name is the camera's name; failing both, with one recording per camera,
 * the cameras' order.
 */
export function matchRecordings(cams: OnvifSourceChannel[], recs: OnvifRecording[]): Map<number, OnvifRecording[]> {
  const out = new Map<number, OnvifRecording[]>();
  const add = (ch: number, r: OnvifRecording) => out.set(ch, [...(out.get(ch) ?? []), r]);
  const unmatched: OnvifRecording[] = [];
  for (const r of recs) {
    const cam = cams.find((c) => r.sourceId !== undefined && (r.sourceId === c.sourceToken || r.sourceId === c.profileToken))
      ?? cams.find((c) => r.sourceName !== undefined && r.sourceName.trim().toLowerCase() === c.name.trim().toLowerCase());
    if (cam) add(cam.channel, r);
    else unmatched.push(r);
  }
  if (unmatched.length && unmatched.length === recs.length && recs.length === cams.length) {
    recs.forEach((r, i) => add(cams[i]!.channel, r));
  }
  return out;
}
