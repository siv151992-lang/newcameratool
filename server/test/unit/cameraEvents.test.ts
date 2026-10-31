import { describe, expect, it } from "vitest";
import { dahuaEvent, DahuaEventReader, hikvisionEvent, HikvisionEventReader, type CameraEvent } from "../../src/integrations/events.js";
import { compareFirmware } from "../../src/services/firmwareService.js";

const alert = (type: string, state = "active", ch = 1) =>
  `<EventNotificationAlert version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><ipAddress>10.0.0.5</ipAddress><channelID>${ch}</channelID><eventType>${type}</eventType><eventState>${state}</eventState><eventDescription>x</eventDescription></EventNotificationAlert>`;

describe("Hikvision camera events", () => {
  it("reads tampering, video loss, faults and failed logins, and ignores motion and the like", () => {
    expect(hikvisionEvent(alert("shelteralarm"))).toMatchObject({ kind: "tamper", state: "active", channel: 1 });
    expect(hikvisionEvent(alert("tamperdetection", "inactive"))).toMatchObject({ kind: "tamper", state: "inactive" });
    expect(hikvisionEvent(alert("videoloss", "active", 3))).toMatchObject({ kind: "video_loss", channel: 3, repeatsWithinMs: 120_000 });
    expect(hikvisionEvent(alert("diskerror"))).toMatchObject({ kind: "device_fault" });
    expect(hikvisionEvent(alert("illAccess"))).toMatchObject({ kind: "illegal_login" });
    expect(hikvisionEvent(alert("VMD"))).toBeNull();
    expect(hikvisionEvent(alert("linedetection"))).toBeNull();
    expect(hikvisionEvent("<EventNotificationAlert></EventNotificationAlert>")).toBeNull();
  });

  it("reads a multipart stream however it is cut, with pictures between the documents", () => {
    const got: CameraEvent[] = [];
    const reader = new HikvisionEventReader((e) => got.push(e));
    const picture = Buffer.from([0xff, 0xd8, 0x00, 0x3c, 0x45, 0xff, 0xd9]);
    const stream = Buffer.concat([
      Buffer.from(`--boundary\r\nContent-Type: application/xml\r\nContent-Length: 300\r\n\r\n${alert("videoloss", "inactive")}\r\n`),
      Buffer.from("--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: 7\r\n\r\n"), picture, Buffer.from("\r\n"),
      Buffer.from(`--boundary\r\nContent-Type: application/xml\r\n\r\n${alert("shelteralarm")}\r\n--boundary\r\n${alert("VMD")}`),
    ]);
    for (let i = 0; i < stream.length; i += 7) reader.push(stream.subarray(i, i + 7));
    expect(got.map((e) => `${e.kind}:${e.state}`)).toEqual(["video_loss:inactive", "tamper:active"]);
  });
});

describe("Dahua camera events", () => {
  it("reads Start, Stop and Pulse, numbering channels from 1", () => {
    expect(dahuaEvent("Code=VideoBlind;action=Start;index=0")).toMatchObject({ kind: "tamper", state: "active", channel: 1 });
    expect(dahuaEvent("Code=VideoBlind;action=Stop;index=0")).toMatchObject({ state: "inactive" });
    expect(dahuaEvent("Code=VideoLoss;action=Start;index=2")).toMatchObject({ kind: "video_loss", channel: 3 });
    expect(dahuaEvent("Code=StorageFailure;action=Pulse;index=0")).toMatchObject({ kind: "device_fault", repeatsWithinMs: 0 });
    expect(dahuaEvent("Code=VideoMotion;action=Start;index=0")).toBeNull();
    expect(dahuaEvent("Heartbeat")).toBeNull();
  });

  it("reads lines cut across chunks", () => {
    const got: CameraEvent[] = [];
    const reader = new DahuaEventReader((e) => got.push(e));
    const text = "--myboundary\r\nContent-Type: text/plain\r\nContent-Length: 36\r\n\r\nCode=VideoBlind;action=Start;index=0\r\n\r\n--myboundary\r\nContent-Type: text/plain\r\n\r\nHeartbeat\r\n\r\n--myboundary\r\n\r\nCode=LoginFailure;action=Pulse;index=0\r\n";
    for (let i = 0; i < text.length; i += 5) reader.push(Buffer.from(text.slice(i, i + 5)));
    expect(got.map((e) => e.kind)).toEqual(["tamper", "illegal_login"]);
  });
});

describe("firmware versions", () => {
  it("orders versions by their numbers, then their build", () => {
    expect(compareFirmware("V5.5.82 build 190220", "V5.7.3 build 220112")).toBeLessThan(0);
    expect(compareFirmware("V5.7.3 build 220112", "V5.7.3 build 211202")).toBeGreaterThan(0);
    expect(compareFirmware("V5.7.10", "V5.7.9")).toBeGreaterThan(0);
    expect(compareFirmware("2.800.0000000.17.R, Build Date: 2021-01-08", "2.800.0000000.17.R, Build Date: 2022-03-01")).toBeLessThan(0);
    expect(compareFirmware("10.12.165", "10.12.165")).toBe(0);
  });
});
