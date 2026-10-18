import { describe, expect, it } from "vitest";
import { MIB, mapHikvisionStatus, parseDeviceInfoXml, parseResponseStatus, parseStorageXml } from "../../src/integrations/hikvision/parser.js";
import { CameraApiError } from "../../src/integrations/types.js";
import { DEFAULT_DEVICE_INFO, storageXml } from "../../src/testing/mockHikvision.js";

// Output captured from a real camera (see project brief), including both namespaces.
const REAL_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<storage version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<hddList version="1.0" xmlns="http://www.hikvision.com/ver10/XMLSchema">
<hdd>
<id>1</id>
<hddName>hdde</hddName>
<hddPath></hddPath>
<hddType>SATA</hddType>
<status>ok</status>
<capacity>121942</capacity>
<freeSpace>5632</freeSpace>
<property>RW</property>
<formatType>EXT4</formatType>
</hdd>
</hddList>
<nasList version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<supportMountType opt="NFS,SMB/CIFS"/>
<authentication opt="SMB/CIFS"/>
</nasList>
<workMode>quota</workMode>
</storage>`;

describe("parseStorageXml", () => {
  it("parses a real single-SD-card response and normalises MB to bytes", () => {
    const r = parseStorageXml(REAL_RESPONSE);
    expect(r.devices).toHaveLength(1);
    const d = r.devices[0]!;
    expect(d).toMatchObject({ id: "hdd-1", name: "hdde", type: "SATA", healthStatus: "healthy", rawStatus: "ok", writable: true, formatType: "EXT4" });
    expect(d.totalBytes).toBe(121942 * MIB);
    expect(d.freeBytes).toBe(5632 * MIB);
    expect(d.usedBytes).toBe((121942 - 5632) * MIB);
    expect(d.usedPercentage).toBe(95.38);
    expect(r.totalBytes).toBe(121942 * MIB);
    expect(r.usedPercentage).toBe(95.38);
  });

  it("parses the brief's example (capitalised root, no namespace)", () => {
    const xml = `<Storage><hddList><hdd><id>1</id><hddName>hdde</hddName><hddPath></hddPath><hddType>SATA</hddType>
      <status>ok</status><capacity>121942</capacity><freeSpace>56362</freeSpace><property>RW</property><formatType>EXT4</formatType></hdd></hddList></Storage>`;
    const r = parseStorageXml(xml);
    expect(r.usedPercentage).toBe(53.78);
    expect(r.freeBytes).toBe(56362 * MIB);
  });

  it("aggregates multiple storage devices", () => {
    const r = parseStorageXml(
      storageXml([
        { id: 1, name: "a", status: "ok", capacityMb: 1000, freeMb: 250, property: "RW" },
        { id: 2, name: "b", status: "ok", capacityMb: 3000, freeMb: 750, property: "RW" },
      ]),
    );
    expect(r.devices.map((d) => d.id)).toEqual(["hdd-1", "hdd-2"]);
    expect(r.totalBytes).toBe(4000 * MIB);
    expect(r.freeBytes).toBe(1000 * MIB);
    expect(r.usedBytes).toBe(3000 * MIB);
    expect(r.usedPercentage).toBe(75);
  });

  it("leaves missing or invalid fields undefined instead of guessing", () => {
    const r = parseStorageXml(storageXml([{ id: 3, status: "ok", capacityMb: "abc" }, { id: 4, capacityMb: 2000, freeMb: 1000 }]));
    expect(r.devices[0]).toMatchObject({ id: "hdd-3", totalBytes: undefined, freeBytes: undefined });
    expect(r.devices[0]!.usedPercentage).toBeUndefined();
    expect(r.devices[1]).toMatchObject({ id: "hdd-4", healthStatus: "unknown", rawStatus: undefined, usedPercentage: 50 });
    // Totals only include devices that report both values.
    expect(r.totalBytes).toBe(2000 * MIB);
  });

  it("does not invent usage when free space exceeds capacity", () => {
    const r = parseStorageXml(storageXml([{ id: 1, status: "ok", capacityMb: 100, freeMb: 200 }]));
    expect(r.devices[0]!.usedPercentage).toBeUndefined();
    expect(r.totalBytes).toBeUndefined();
  });

  it("handles zero capacity without dividing by zero", () => {
    const r = parseStorageXml(storageXml([{ id: 1, status: "unformatted", capacityMb: 0, freeMb: 0 }]));
    expect(r.devices[0]!.usedPercentage).toBeUndefined();
    expect(r.devices[0]!.healthStatus).toBe("unhealthy");
  });

  it("returns no devices when the camera reports an empty list", () => {
    expect(parseStorageXml(storageXml([])).devices).toEqual([]);
    expect(parseStorageXml("<storage><workMode>quota</workMode></storage>").devices).toEqual([]);
  });

  it("detects read-only storage", () => {
    expect(parseStorageXml(storageXml([{ id: 1, status: "ok", capacityMb: 10, freeMb: 5, property: "RO" }])).devices[0]!.writable).toBe(false);
  });

  it("rejects malformed XML and non-XML bodies", () => {
    for (const bad of ["", "not xml", "<storage><hddList><hdd>broken", "{\"json\":true}"]) {
      expect(() => parseStorageXml(bad)).toThrowError(CameraApiError);
      try {
        parseStorageXml(bad);
      } catch (e) {
        expect((e as CameraApiError).code).toBe("INVALID_RESPONSE");
      }
    }
  });

  it("rejects an unexpected root element", () => {
    expect(() => parseStorageXml("<html><body>login</body></html>")).toThrow(/Unexpected XML/);
  });

  it("classifies ISAPI ResponseStatus errors", () => {
    const xml = "<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>";
    expect(parseResponseStatus(xml)?.code).toBe("API_UNAVAILABLE");
    expect(() => parseStorageXml(xml)).toThrow(/Invalid Operation/);
    expect(parseResponseStatus("<storage/>")).toBeUndefined();
  });
});

describe("mapHikvisionStatus", () => {
  it.each([
    ["ok", "healthy"], ["OK", "healthy"], ["idle", "healthy"],
    ["formating", "degraded"], ["reparing", "degraded"],
    ["error", "unhealthy"], ["unformatted", "unhealthy"], ["smartFailed", "unhealthy"], ["notexist", "unhealthy"],
    ["somethingNew", "unknown"], [undefined, "unknown"],
  ])("%s → %s", (raw, expected) => {
    expect(mapHikvisionStatus(raw)).toBe(expected);
  });
});

describe("parseDeviceInfoXml", () => {
  it("extracts model, serial and firmware", () => {
    expect(parseDeviceInfoXml(DEFAULT_DEVICE_INFO)).toMatchObject({
      model: "SIMULATED-HIKVISION",
      serialNumber: "SIM0000000001",
      firmwareVersion: "V0.0.0 build 000000",
    });
  });
});
