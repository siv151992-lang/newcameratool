import { describe, expect, it } from "vitest";
import { parsePanasonicDeviceInfo, parsePanasonicRecording, parsePanasonicStorage } from "../../src/integrations/panasonic/parser.js";
import { MIB } from "../../src/integrations/parsing.js";
import { WV_S35402_GETINFO, WV_S35402_SDCARD_PAGE } from "../fixtures/panasonic-wv-s35402.js";

describe("Panasonic / i-PRO WV-S35402-F2L (real replies)", () => {
  it("reads SD card 1 from the SD memory card page and skips the empty slot 2", () => {
    const r = parsePanasonicStorage(WV_S35402_SDCARD_PAGE);
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({ id: "1", name: "SD card 1", healthStatus: "healthy", totalBytes: 243952 * MIB, freeBytes: 696 * MIB });
    expect(r.usedPercentage).toBeCloseTo(99.71, 1);
    expect(r.totalBytes! / 1e9).toBeCloseTo(255.8, 1);
  });

  it("does not mistake sTotalSDplus or display variables for capacity", () => {
    const tricky = 'var sTotalSDplus = 5;\nvar sRemSDview = "1";\nvar sRemSD = "100";\nvar sTotalSD = "1000";';
    expect(parsePanasonicStorage(tricky)).toMatchObject({ totalBytes: 1000 * MIB, freeBytes: 100 * MIB });
  });

  it("reads model, serial, firmware and MAC, and SD recording", () => {
    expect(parsePanasonicDeviceInfo(WV_S35402_GETINFO)).toEqual({
      model: "WV-S35402-F2L", serialNumber: "YLA09673", firmwareVersion: "3.50 (s32302)", macAddress: "D4:2D:C5:83:D8:51",
    });
    expect(parsePanasonicRecording(WV_S35402_GETINFO)).toMatchObject({ state: "recording", detail: "SD recording is on (SDrec=on)" });
    expect(parsePanasonicRecording(WV_S35402_GETINFO.replace("SDrec=on", "SDrec=off")).state).toBe("idle");
    expect(parsePanasonicRecording(WV_S35402_GETINFO.replace("SDrec=on\r\n", "")).state).toBe("unknown");
  });

  it("handles no card, placeholder states and unexpected pages", () => {
    const none = WV_S35402_SDCARD_PAGE.replace('sRemSD = "696"', 'sRemSD = "-"').replace('sTotalSD = "243952"', 'sTotalSD = "-"');
    expect(parsePanasonicStorage(none).devices).toEqual([]);
    const busy = WV_S35402_SDCARD_PAGE.replace('sRemSD = "696"', 'sRemSD = "*"').replace('sTotalSD = "243952"', 'sTotalSD = "*"');
    expect(parsePanasonicStorage(busy).devices[0]).toMatchObject({ healthStatus: "unknown", totalBytes: undefined, rawStatus: 'Capacity shown as "*/*"' });
    expect(() => parsePanasonicStorage("<html><title>Login</title></html>")).toThrow(/administrator rights/);
    expect(() => parsePanasonicStorage("<html>other page</html>")).toThrow(/expected capacity values/);
  });
});
