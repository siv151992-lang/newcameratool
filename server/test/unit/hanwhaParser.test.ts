import { describe, expect, it } from "vitest";
import { parseHanwhaDeviceInfo, parseHanwhaStorage, parseSunapiError, parseSunapiSize } from "../../src/integrations/hanwha/parser.js";
import { MIB } from "../../src/integrations/parsing.js";

describe("Hanwha SUNAPI storage", () => {
  it("reads key=value replies (sizes in MB) and skips empty slots", () => {
    const body = [
      "Storage.0.Type=MicroSD", "Storage.0.Enable=True", "Storage.0.Status=Normal", "Storage.0.TotalSpace=122000", "Storage.0.FreeSpace=30500",
      "Storage.1.Type=MicroSD", "Storage.1.Status=None", "Storage.1.TotalSpace=0", "Storage.1.FreeSpace=0",
    ].join("\r\n");
    const r = parseHanwhaStorage(body);
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({ id: "0", name: "MicroSD", healthStatus: "healthy", rawStatus: "Normal" });
    expect(r).toMatchObject({ totalBytes: 122000 * MIB, freeBytes: 30500 * MIB, usedPercentage: 75 });
  });

  it("reads JSON replies, used space and unit suffixes", () => {
    const body = JSON.stringify({ Storages: [
      { Storage: 0, Type: "SD", Status: "Recording", TotalSpace: "64 GB", UsedSpace: "16 GB" },
      { Storage: 1, Type: "NAS", Status: "Fail", TotalSpace: 1000, FreeSpace: 1000 },
    ] });
    const r = parseHanwhaStorage(body);
    expect(r.devices.map((d) => [d.id, d.healthStatus])).toEqual([["0", "healthy"], ["1", "unhealthy"]]);
    expect(r.devices[0]).toMatchObject({ totalBytes: 64 * 1024 * MIB, freeBytes: 48 * 1024 * MIB });
  });

  it("marks read-only cards and refuses replies without storage entries", () => {
    expect(parseHanwhaStorage("Storage.0.Status=ReadOnly\nStorage.0.TotalSpace=100\nStorage.0.FreeSpace=50").devices[0]).toMatchObject({ healthStatus: "unhealthy", writable: false });
    expect(() => parseHanwhaStorage("Model=XNV-8080R")).toThrow(/no storage entries/);
    expect(() => parseHanwhaStorage("{not json")).toThrow(/malformed JSON/);
  });

  it("parses sizes strictly", () => {
    expect(parseSunapiSize("1024")).toBe(1024 * MIB);
    expect(parseSunapiSize("2 GB")).toBe(2 * 1024 * MIB);
    expect(parseSunapiSize("128000000000")).toBe(128_000_000_000); // too large for MB: bytes
    for (const bad of ["-5", "1e9", "abc", ""]) expect(parseSunapiSize(bad), bad).toBeUndefined();
  });

  it("classifies SUNAPI error replies", () => {
    expect(parseSunapiError("NG\r\nError Code: 600\r\nError Details: Submenu Not Found")).toMatchObject({ code: "API_UNAVAILABLE" });
    expect(parseSunapiError("NG\r\nError Code: 607\r\nError Details: Not authorized")).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(parseSunapiError('{"Response":"Fail","Error":{"Code":604,"Details":"Invalid value"}}')).toMatchObject({ code: "API_ERROR" });
    expect(parseSunapiError("Storage.0.Status=Normal")).toBeUndefined();
    expect(() => parseHanwhaStorage("NG\r\nError Code: 600")).toThrow(/does not provide storage information/);
  });
});

describe("Hanwha SUNAPI device information", () => {
  it("reads key=value and JSON replies", () => {
    expect(parseHanwhaDeviceInfo("Model=XNV-8080R\r\nSerialNumber=ZM1234\r\nFirmwareVersion=2.21.02\r\nConnectedMACAddress=00:09:18:aa:bb:cc\r\nDeviceName=Gate")).toEqual({
      deviceName: "Gate", model: "XNV-8080R", serialNumber: "ZM1234", firmwareVersion: "2.21.02", macAddress: "00:09:18:AA:BB:CC",
    });
    expect(parseHanwhaDeviceInfo(JSON.stringify({ Model: "QNV-6012R", FirmwareVersion: "1.41.00" }))).toMatchObject({ model: "QNV-6012R", firmwareVersion: "1.41.00" });
  });
});
