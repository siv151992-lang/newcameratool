import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { forecastUsage } from "../../src/ai/forecast.js";
import { type AssistantModel, chatSchema, runAssistant } from "../../src/ai/assistant.js";
import { type CameraInsight, type FleetInsights, INSIGHTS_FORECAST_LIMIT, insightsForClient } from "../../src/ai/insightsService.js";
import { runTool, toolsFor } from "../../src/ai/tools.js";

type Msg = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 3_600_000;

function insight(name: string, host: string, over: Partial<CameraInsight["camera"]> = {}, perDay = 2): CameraInsight {
  const points = Array.from({ length: 7 * 24 + 1 }, (_, i) => ({ t: NOW - (7 * 24 - i) * HOUR, usedPercentage: 60 + (perDay * i) / 24, totalBytes: 128e9 }));
  const camera = {
    id: `${name.toLowerCase().replace(/\s/g, "-")}-id`, name, host, location: "Office", brand: "hikvision", monitoringEnabled: true,
    connection: "online", storageHealth: "healthy", recordingState: "recording", recordingDetail: null, usedPercentage: 60 + perDay * 7,
    totalBytes: 128e9, usedBytes: 0.74 * 128e9, freeBytes: 0.26 * 128e9, lastSuccessAt: NOW, lastAttemptAt: NOW, lastErrorCode: null,
    lastErrorMessage: null, warningThreshold: 80, criticalThreshold: 90, openAlerts: [], disconnects24h: 0, disconnects7d: 0, ...over,
  } as CameraInsight["camera"];
  const forecast = forecastUsage(points, { warningThreshold: 80, criticalThreshold: 90, now: NOW });
  return { camera, forecast, anomalies: [], health: { score: 100, grade: "good", factors: [] }, actions: [], link: `/cameras/${camera.id}` };
}

const fleet: FleetInsights = {
  generatedAt: new Date(NOW).toISOString(),
  historyDays: 14,
  cameras: [insight("Office Camera 03", "10.10.15.3", {}, 3), insight("Entrance Camera 07", "10.10.15.7", { connection: "offline" }, 0)],
  actions: [],
  summary: { cameras: 2, monitored: 2, offline: 1, notRecording: 0, storageCritical: 0, storageWarning: 0, criticalWithin7Days: 1, anomalies: 0, averageHealth: 100 },
};

/** A fake model that replays scripted responses and records every request it received. */
function scripted(...responses: Partial<Msg>[]) {
  const requests: Params[] = [];
  const model: AssistantModel = {
    create: async (params) => {
      requests.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error("no more scripted responses");
      return { id: "msg", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", content: [], ...next } as Msg;
    },
  };
  return { model, requests };
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.Beta.Messages.BetaToolUseBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.Messages.BetaTextBlock;
const ORG = "00000000-0000-4000-8000-000000000001";
const ADMIN = { permissions: ["cameras:read", "alerts:read"], organizationId: ORG };
const ask = (q: string) => chatSchema.parse({ messages: [{ role: "user", content: q }] });

describe("runAssistant", () => {
  it("calls the tools Claude asks for and answers from their results", async () => {
    const { model, requests } = scripted(
      { stop_reason: "tool_use", content: [toolUse("t1", "get_storage_forecasts", { threshold: "critical", within_days: 7 }), toolUse("t2", "list_cameras", { connection: "offline" })] },
      { stop_reason: "end_turn", content: [text("Office Camera 03 is projected to reach 90% in about 1 day.")] },
    );
    const result = await runAssistant(ask("Which cameras may run out of storage in the next seven days?"), ADMIN, { model, now: NOW, insights: async () => fleet });

    expect(result.answer).toBe("Office Camera 03 is projected to reach 90% in about 1 day.");
    expect(result.toolCalls.map((t) => [t.name, t.isError])).toEqual([["get_storage_forecasts", false], ["list_cameras", false]]);

    const first = requests[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(first.fallbacks).toBe("default");
    expect(first.tools!.map((t) => (t as { name: string }).name)).toContain("get_alerts");
    // Both tool results go back in one user message, after the assistant's tool calls.
    const second = requests[1]!;
    const results = second.messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
    const forecastResult = JSON.parse(results[0]!.content as string);
    expect(forecastResult.cameras.map((c: { name: string }) => c.name)).toEqual(["Office Camera 03"]);
    expect(forecastResult.cameras[0].forecast.kind).toBe("estimate");
    expect(JSON.parse(results[1]!.content as string).cameras[0]).toMatchObject({ name: "Entrance Camera 07", ip: "10.10.15.7", link: "/cameras/entrance-camera-07-id" });
  });

  it("returns validation errors to the model instead of running a malformed call", async () => {
    const { model, requests } = scripted(
      { stop_reason: "tool_use", content: [toolUse("t1", "get_storage_forecasts", { threshold: "soon", within_days: -3 })] },
      { stop_reason: "end_turn", content: [text("Sorry.")] },
    );
    const result = await runAssistant(ask("x"), ADMIN, { model, now: NOW, insights: async () => fleet });
    const toolResult = (requests[1]!.messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0]!;
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/Invalid input: threshold/);
    expect(result.toolCalls[0]!.isError).toBe(true);
  });

  it("only offers tools the user is allowed to use, and refuses unknown or forbidden ones", async () => {
    expect(toolsFor(["cameras:read"]).map((t) => t.name)).not.toContain("get_alerts");
    const ctx = { permissions: ["cameras:read"], organizationId: ORG, now: NOW, insights: async () => fleet };
    expect(await runTool("get_alerts", {}, ctx)).toEqual({ content: 'Unknown or unavailable tool "get_alerts".', isError: true });
    expect((await runTool("drop_table", {}, ctx)).isError).toBe(true);
  });

  it("finds cameras by IP or partial name and lists candidates when ambiguous", async () => {
    const db = { query: async () => ({ rows: [] }) } as unknown as import("../../src/db/pool.js").Queryable;
    const ctx = { permissions: ADMIN.permissions, organizationId: ORG, now: NOW, insights: async () => fleet, db };
    const byIp = JSON.parse((await runTool("get_camera_details", { camera: "10.10.15.3" }, { ...ctx, insights: async () => ({ ...fleet, cameras: [fleet.cameras[0]!] }) })).content);
    expect(byIp.observed).toMatchObject({ name: "Office Camera 03", usedPercent: 81 });
    expect(byIp.forecast).toMatchObject({ kind: "estimate", status: "growing", daysToCritical: 3 });
    const ambiguous = JSON.parse((await runTool("get_camera_details", { camera: "camera" }, ctx)).content);
    expect(ambiguous.found).toBe(2);
    expect(JSON.parse((await runTool("get_camera_details", { camera: "nothing" }, ctx)).content).found).toBe(0);
  });

  it("handles refusals, pause_turn, truncation and runaway loops", async () => {
    const deps = (m: AssistantModel) => ({ model: m, now: NOW, insights: async () => fleet });
    expect((await runAssistant(ask("x"), ADMIN, deps(scripted({ stop_reason: "refusal", content: [] }).model))).answer).toBe("I can't help with that request.");

    const paused = scripted({ stop_reason: "pause_turn", content: [text("…")] }, { stop_reason: "end_turn", content: [text("Done.")] });
    expect((await runAssistant(ask("x"), ADMIN, deps(paused.model))).answer).toBe("Done.");

    const cut = await runAssistant(ask("x"), ADMIN, deps(scripted({ stop_reason: "max_tokens", content: [text("Partial")] }).model));
    expect(cut.answer).toMatch(/^Partial\n\n_\(The answer was cut short\.\)_$/);

    const loop = scripted(...Array.from({ length: 8 }, (_, i) => ({ stop_reason: "tool_use" as const, content: [toolUse(`t${i}`, "get_fleet_overview", {})] })));
    expect((await runAssistant(ask("x"), ADMIN, deps(loop.model))).stopReason).toBe("max_rounds");
  });

  it("validates the conversation shape", () => {
    expect(chatSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(chatSchema.safeParse({ messages: [{ role: "assistant", content: "hi" }] }).success).toBe(false);
    expect(chatSchema.safeParse({ messages: [{ role: "user", content: "x".repeat(4001) }] }).success).toBe(false);
    expect(chatSchema.safeParse({ messages: [{ role: "user", content: "hi" }], extra: 1 }).success).toBe(false);
  });
});

describe("insights sent to the browser", () => {
  it("keeps the cameras most in need of attention and closest to critical, not all 20 000", () => {
    const poor = Array.from({ length: 700 }, (_, i) => ({ ...insight(`Poor ${i}`, `10.1.${i >> 8}.${i & 255}`), health: { score: i, grade: "poor" as const, factors: [] } }));
    const healthy = Array.from({ length: 2000 }, (_, i) => insight(`Fine ${i}`, `10.2.${i >> 8}.${i & 255}`, {}, (i % 20) / 10));
    const out = insightsForClient({ ...fleet, cameras: [...healthy, ...poor] });
    expect(out.camerasTotal).toBe(2700);
    expect(out.camerasShown).toBe(2 * INSIGHTS_FORECAST_LIMIT);
    const shownPoor = out.cameras.filter((c) => c.health.grade === "poor");
    expect(shownPoor).toHaveLength(INSIGHTS_FORECAST_LIMIT);
    expect(Math.max(...shownPoor.map((c) => c.health.score))).toBe(INSIGHTS_FORECAST_LIMIT - 1); // the worst ones
    const days = out.cameras.filter((c) => c.health.grade === "good").map((c) => c.forecast.daysToCritical ?? Infinity);
    const unshown = healthy.filter((h) => !out.cameras.includes(h)).map((c) => c.forecast.daysToCritical ?? Infinity);
    expect(Math.max(...days)).toBeLessThanOrEqual(Math.min(...unshown)); // the soonest to critical
    expect(out.summary).toBe(fleet.summary); // the summary still covers every camera
  });
});

