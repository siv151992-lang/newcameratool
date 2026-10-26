import { describe, expect, it } from "vitest";
import { parseDahuaChannels, parseDahuaRecording } from "../../src/integrations/dahua/parser.js";
import { parseSunapiChannels } from "../../src/integrations/hanwha/parser.js";
import { parseHikvisionChannels, parseRecordingStatusXml } from "../../src/integrations/hikvision/parser.js";
import { parseUniviewChannels } from "../../src/integrations/uniview/parser.js";
import { evaluateConditions } from "../../src/monitoring/evaluate.js";
import { DEFAULT_MONITORING_SETTINGS } from "../../src/services/settingsService.js";

describe("NVR channels", () => {
  it("Hikvision: names, video and recording per channel (track 101 = channel 1)", () => {
    const ns = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"';
    const channels = `<InputProxyChannelList ${ns}><InputProxyChannel><id>1</id><name>Gate</name></InputProxyChannel><InputProxyChannel><id>2</id><name>Lobby</name></InputProxyChannel></InputProxyChannelList>`;
    const status = `<InputProxyChannelStatusList ${ns}><InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus><InputProxyChannelStatus><id>2</id><online>false</online></InputProxyChannelStatus></InputProxyChannelStatusList>`;
    const rec = parseRecordingStatusXml(`<RecordingStatus ${ns}><status>recording</status><TrackStatusList><TrackStatus><id>101</id><videoRecordStatus>recording</videoRecordStatus></TrackStatus><TrackStatus><id>201</id><videoRecordStatus>notRecording</videoRecordStatus></TrackStatus></TrackStatusList></RecordingStatus>`);
    expect(parseHikvisionChannels(channels, status, rec)).toEqual([
      { channel: 1, name: "Gate", online: true, recording: "recording" },
      { channel: 2, name: "Lobby", online: false, recording: "idle" },
    ]);
  });

  it("Dahua: titles, camera state and record status (channels from 0)", () => {
    const titles = "table.ChannelTitle[0].Name=Gate\r\ntable.ChannelTitle[1].Name=Lobby\r\n";
    const states = "states[0].channel=0\r\nstates[0].connectionState=Connected\r\nstates[1].channel=1\r\nstates[1].connectionState=Disconnected\r\n";
    const rec = parseDahuaRecording("status.Channels[0].RecordStatus=1\r\nstatus.Channels[1].RecordStatus=0\r\n");
    expect(parseDahuaChannels(titles, states, rec)).toEqual([
      { channel: 1, name: "Gate", online: true, recording: "recording" },
      { channel: 2, name: "Lobby", online: false, recording: "idle" },
    ]);
  });

  it("Uniview: channel list with online status", () => {
    const body = JSON.stringify({ Response: { ResponseCode: 0, StatusCode: 0, Data: { Nums: 2, BasicInfos: [{ ID: 1, Name: "Gate", Status: 1 }, { ID: 2, Name: "Lobby", Status: 0 }] } } });
    expect(parseUniviewChannels(body)).toEqual([
      { channel: 1, name: "Gate", online: true },
      { channel: 2, name: "Lobby", online: false },
    ]);
  });

  it("Hanwha: video loss and recording from the event status", () => {
    expect(parseSunapiChannels("Channel.0.VideoLoss=False\r\nChannel.0.Recording=True\r\nChannel.1.VideoLoss=True\r\n")).toEqual([
      { channel: 1, online: true, recording: "recording" },
      { channel: 2, online: false },
    ]);
  });

  it("raises one alert per NVR: critical for video loss, warning when only not recording", () => {
    const base = {
      result: { ok: true as const, reading: { devices: [{ id: "1", healthStatus: "healthy" as const }] } },
      connectionStatus: "online" as const, consecutiveFailures: 0, consecutiveAuthFailures: 0, minutesWithoutStorage: 0,
      thresholds: { warning: 80, critical: 90, full: 98, hysteresis: 3, usageAlertsEnabled: true },
      settings: DEFAULT_MONITORING_SETTINGS, openTypes: new Set<never>(),
    };
    const notRecording = evaluateConditions({ ...base, channels: [{ channel: 1, online: true, recording: "idle" }] });
    expect(notRecording.active.find((a) => a.type === "nvr_channel")).toMatchObject({ severity: "warning", title: "NVR: 1 channel not recording" });
    const lost = evaluateConditions({ ...base, channels: [{ channel: 1, online: false }, { channel: 2, name: "Lobby", online: true, recording: "idle" }] });
    expect(lost.active.find((a) => a.type === "nvr_channel")).toMatchObject({ severity: "critical", description: "No video from channel 1. Not recording: channel 2 (Lobby)." });
    const fine = evaluateConditions({ ...base, channels: [{ channel: 1, online: true, recording: "recording" }] });
    expect(fine.evaluated).toContain("nvr_channel");
    expect(fine.active.some((a) => a.type === "nvr_channel")).toBe(false);
  });
});
