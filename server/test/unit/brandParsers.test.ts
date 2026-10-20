import { describe, expect, it } from "vitest";
import { parseAxisStorage } from "../../src/integrations/axis/parser.js";
import { parseDahuaStorage, unescapeLineBreaks } from "../../src/integrations/dahua/parser.js";
import { parseOnvifStorage } from "../../src/integrations/onvif/parser.js";
import { MIB, parseByteCount, parseKeyValueLines } from "../../src/integrations/parsing.js";
import { parseUniviewStorage } from "../../src/integrations/uniview/parser.js";
import { CameraApiError } from "../../src/integrations/types.js";

const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CameraApiError);
    return (e as CameraApiError).code;
  }
  throw new Error("expected the parser to throw");
};

describe("shared parsing helpers", () => {
  it("parses byte counts strictly", () => {
    expect(parseByteCount("1495797858304")).toBe(1495797858304);
    expect(parseByteCount("1495797858304.000000")).toBe(1495797858304);
    expect(parseByteCount(128000, MIB)).toBe(128000 * MIB);
    expect(parseByteCount("-5")).toBeUndefined();
    expect(parseByteCount("12abc")).toBeUndefined();
    expect(parseByteCount("")).toBeUndefined();
    expect(parseByteCount(undefined)).toBeUndefined();
    expect(parseByteCount("99999999999999999999")).toBeUndefined();
  });

  it("splits key=value lines with any line ending and keeps '=' inside values", () => {
    expect(parseKeyValueLines("a=1\r\nb=x=y\rc = 3\n# comment\nnoequals\n")).toEqual([
      ["a", "1"], ["b", "x=y"], ["c", "3"],
    ]);
  });
});

describe("parseAxisStorage", () => {
  // Reference sheet payload (the duplicated WearLevel line is in the original).
  const SHEET = "Storage.S0.DriveStatus=Normal\nStorage.S0.TotalSize=122048\nStorage.S0.WearLevel=12\nStorage.S0.WearLevel=12\n";

  it("parses the reference payload: one disk, capacity in MiB, no usage reported", () => {
    const r = parseAxisStorage(SHEET);
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({ id: "S0", name: "S0", healthStatus: "healthy", rawStatus: "Normal", totalBytes: 122048 * MIB });
    expect(r.devices[0]!.freeBytes).toBeUndefined();
    expect(r.devices[0]!.usedBytes).toBeUndefined();
    expect(r.usedPercentage).toBeUndefined();
  });

  it("computes usage when free or used size is also reported, across several disks", () => {
    const r = parseAxisStorage(
      "Storage.S1.DriveStatus=Normal\r\nStorage.S1.TotalSize=2000\r\nStorage.S1.UsedSize=500\r\n" +
        "Storage.S0.DriveStatus=Normal\r\nStorage.S0.TotalSize=1000\r\nStorage.S0.FreeSize=250\r\n",
    );
    expect(r.devices.map((d) => d.id)).toEqual(["S0", "S1"]);
    expect(r.devices[0]).toMatchObject({ freeBytes: 250 * MIB, usedBytes: 750 * MIB, usedPercentage: 75 });
    expect(r.devices[1]).toMatchObject({ freeBytes: 1500 * MIB, usedBytes: 500 * MIB });
    expect(r).toMatchObject({ totalBytes: 3000 * MIB, usedBytes: 1250 * MIB, freeBytes: 1750 * MIB });
  });

  it("maps failure states and drops empty slots", () => {
    const r = parseAxisStorage("Storage.S0.DriveStatus=Error\nStorage.S1.DriveStatus=Absent\n");
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({ id: "S0", healthStatus: "unhealthy" });
  });

  it("classifies error bodies and unrelated text", () => {
    expect(errorCode(() => parseAxisStorage("# Error: Error -1 getting param in group 'Storage'\n"))).toBe("API_UNAVAILABLE");
    expect(errorCode(() => parseAxisStorage("# Error: Request failed\n"))).toBe("API_ERROR");
    expect(errorCode(() => parseAxisStorage("<html>login</html>"))).toBe("INVALID_RESPONSE");
    expect(errorCode(() => parseAxisStorage(""))).toBe("INVALID_RESPONSE");
  });
});

describe("parseUniviewStorage", () => {
  const SHEET = JSON.stringify({
    Disks: [{ ID: 1, Name: "sdcard0", Status: "Normal", Type: "Local", TotalCapacity: 128000, UsedCapacity: 64500, FreeCapacity: 63500 }],
  });

  it("parses the reference payload and normalises MiB to bytes", () => {
    const r = parseUniviewStorage(SHEET);
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({
      id: "disk-1", name: "sdcard0", type: "Local", healthStatus: "healthy", rawStatus: "Normal",
      totalBytes: 128000 * MIB, freeBytes: 63500 * MIB, usedBytes: 64500 * MIB,
    });
    expect(r.usedPercentage).toBe(50.39);
  });

  it("accepts the LAPI Response/Data envelope, lower-case keys and a missing FreeCapacity", () => {
    const body = JSON.stringify({
      Response: { ResponseURL: "/LAPI/V1.0/Storage", StatusCode: 0, StatusString: "Succeed",
        Data: { disks: [{ id: 2, name: "hdd1", status: "Abnormal", totalcapacity: 1000, usedcapacity: 400 }] } },
    });
    const r = parseUniviewStorage(body);
    expect(r.devices[0]).toMatchObject({ id: "disk-2", healthStatus: "unhealthy", freeBytes: 600 * MIB, usedBytes: 400 * MIB });
  });

  it("drops empty slots and ignores non-numeric capacities", () => {
    const r = parseUniviewStorage(JSON.stringify({
      Disks: [{ ID: 1, Status: "NotExist" }, { ID: 2, Status: "Normal", TotalCapacity: "n/a", FreeCapacity: 5 }],
    }));
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]!.totalBytes).toBeUndefined();
    expect(r.totalBytes).toBeUndefined();
  });

  it("classifies errors", () => {
    expect(errorCode(() => parseUniviewStorage("not json"))).toBe("INVALID_RESPONSE");
    expect(errorCode(() => parseUniviewStorage("[]"))).toBe("INVALID_RESPONSE");
    expect(errorCode(() => parseUniviewStorage("{}"))).toBe("INVALID_RESPONSE");
    expect(errorCode(() => parseUniviewStorage(JSON.stringify({ Response: { StatusCode: 4, StatusString: "Not Support" } })))).toBe("API_UNAVAILABLE");
    expect(errorCode(() => parseUniviewStorage(JSON.stringify({ Response: { StatusCode: 1, StatusString: "Failed" } })))).toBe("API_ERROR");
  });
});

describe("parseDahuaStorage", () => {
  // Reference sheet payload: line breaks arrive as literal "\r\n" escape text.
  const SHEET =
    String.raw`list.info.Name=/dev/sda\r\nlist.info.State=Success\r\nlist.info.Detail.IsError=false` +
    String.raw`\r\nlist.info.Detail.TotalBytes=1495797858304\r\nlist.info.Detail.UsedBytes=643829104128\r\n` +
    String.raw`list.info.Name=/dev/sdb\r\nlist.info.State=Absent`;

  it("parses the reference payload with escaped line breaks", () => {
    const r = parseDahuaStorage(SHEET);
    expect(r.devices).toHaveLength(1); // /dev/sdb is Absent
    expect(r.devices[0]).toMatchObject({
      id: "disk-sda", name: "/dev/sda", healthStatus: "healthy", rawStatus: "Success",
      totalBytes: 1495797858304, usedBytes: 643829104128, freeBytes: 1495797858304 - 643829104128,
    });
    expect(r.usedPercentage).toBe(43.04);
  });

  it("gives the same result for real CRLF line breaks and double-escaped text", () => {
    const expected = parseDahuaStorage(SHEET);
    expect(parseDahuaStorage(SHEET.replaceAll(String.raw`\r\n`, "\r\n"))).toEqual(expected);
    expect(parseDahuaStorage(SHEET.replaceAll(String.raw`\r\n`, String.raw`\\r\\n`))).toEqual(expected);
    expect(unescapeLineBreaks(String.raw`a\nb\rc`)).toBe("a\nb\nc");
  });

  it("parses indexed firmware output, summing partitions and decimal byte values", () => {
    const body = [
      "list.info[0].Name=/dev/sda",
      "list.info[0].State=Success",
      "list.info[0].Detail[0].IsError=false",
      "list.info[0].Detail[0].TotalBytes=1000.000000",
      "list.info[0].Detail[0].UsedBytes=400.000000",
      "list.info[0].Detail[1].IsError=false",
      "list.info[0].Detail[1].TotalBytes=3000.000000",
      "list.info[0].Detail[1].UsedBytes=600.000000",
      "list.info[1].Name=/dev/sdb",
      "list.info[1].State=Success",
      "list.info[1].Detail[0].IsError=true",
      "list.info[1].Detail[0].TotalBytes=500",
      "list.info[1].Detail[0].UsedBytes=100",
    ].join("\r\n");
    const r = parseDahuaStorage(body);
    expect(r.devices.map((d) => d.id)).toEqual(["disk-sda", "disk-sdb"]);
    expect(r.devices[0]).toMatchObject({ totalBytes: 4000, usedBytes: 1000, freeBytes: 3000, healthStatus: "healthy" });
    expect(r.devices[1]).toMatchObject({ healthStatus: "unhealthy" }); // IsError=true wins over State
    expect(r).toMatchObject({ totalBytes: 4500, usedBytes: 1100, freeBytes: 3400 });
  });

  it("splits repeated unindexed Detail blocks into partitions", () => {
    const body = [
      "list.info.Name=/dev/sda", "list.info.State=Success",
      "list.info.Detail.TotalBytes=100", "list.info.Detail.UsedBytes=10",
      "list.info.Detail.TotalBytes=200", "list.info.Detail.UsedBytes=20",
    ].join("\n");
    expect(parseDahuaStorage(body).devices[0]).toMatchObject({ totalBytes: 300, usedBytes: 30 });
  });

  it("does not report usage when a partition is unreadable or used exceeds total", () => {
    const partial = parseDahuaStorage("list.info.Name=/dev/sda\nlist.info.State=Success\nlist.info.Detail.TotalBytes=100\n");
    expect(partial.devices[0]!.totalBytes).toBeUndefined();
    const inconsistent = parseDahuaStorage("list.info.Name=/dev/sda\nlist.info.Detail.TotalBytes=100\nlist.info.Detail.UsedBytes=200\n");
    expect(inconsistent.devices[0]!.freeBytes).toBeUndefined();
    expect(inconsistent.usedPercentage).toBeUndefined();
  });

  it("returns no devices when every slot is empty, so the monitor raises no_storage_device", () => {
    expect(parseDahuaStorage("list.info.Name=/dev/sda\r\nlist.info.State=Absent\r\n").devices).toEqual([]);
  });

  it("classifies errors", () => {
    expect(errorCode(() => parseDahuaStorage("Error\r\nBad Request!\r\n"))).toBe("API_UNAVAILABLE");
    expect(errorCode(() => parseDahuaStorage(String.raw`Error\r\nInternal Error`))).toBe("API_ERROR");
    expect(errorCode(() => parseDahuaStorage("OK"))).toBe("INVALID_RESPONSE");
  });
});

describe("parseOnvifStorage", () => {
  const device = (token: string, state: string, total: string, free: string, used: string, enabled = "true") => `
    <tst:StorageDevice>
      <tst:Token>${token}</tst:Token>
      <tst:Configuration><tt:Type>SDCard</tt:Type><tt:Enabled>${enabled}</tt:Enabled></tst:Configuration>
      <tst:Status>
        <tt:State>${state}</tt:State>
        <tt:StorageInfo>
          <!-- All values are raw integers (Bytes) -->
          <tt:TotalSpace>${total}</tt:TotalSpace>
          <tt:FreeSpace>${free}</tt:FreeSpace>
          <tt:UsedSpace>${used}</tt:UsedSpace>
        </tt:StorageInfo>
      </tst:Status>
    </tst:StorageDevice>`;
  const envelope = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tst="http://www.onvif.org/ver10/storage/wsdl">
  <soap:Body><tst:GetStorageDevicesResponse>${inner}</tst:GetStorageDevicesResponse></soap:Body>
</soap:Envelope>`;

  it("parses the reference payload: byte values read from the tt: nodes", () => {
    const r = parseOnvifStorage(envelope(device("StorageToken_SD_Card_1", "Normal", "64023257088", "32110247936", "31913009152")));
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({
      id: "StorageToken_SD_Card_1", name: "StorageToken_SD_Card_1", type: "SDCard", healthStatus: "healthy", rawStatus: "Normal",
      totalBytes: 64023257088, freeBytes: 32110247936, usedBytes: 31913009152,
    });
    expect(r.usedPercentage).toBe(49.85);
  });

  it("handles several devices, other prefixes, a missing FreeSpace and disabled devices", () => {
    const xml = envelope(device("a", "Normal", "1000", "", "250") + device("b", "Normal", "1000", "500", "500", "false"))
      .replaceAll("tst:", "ns1:").replaceAll("xmlns:tst", "xmlns:ns1");
    const r = parseOnvifStorage(xml);
    expect(r.devices.map((d) => d.id)).toEqual(["a", "b"]);
    expect(r.devices[0]).toMatchObject({ freeBytes: 750, usedBytes: 250 });
    expect(r.devices[1]).toMatchObject({ healthStatus: "degraded", rawStatus: "Normal, disabled" });
    expect(r).toMatchObject({ totalBytes: 2000, freeBytes: 1250 });
  });

  it("returns an empty reading for an empty response and drops absent devices", () => {
    expect(parseOnvifStorage(envelope("")).devices).toEqual([]);
    expect(parseOnvifStorage(envelope(device("x", "NotExist", "0", "0", "0"))).devices).toEqual([]);
  });

  it("classifies SOAP faults and malformed bodies", () => {
    const fault = (sub: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:ter="http://www.onvif.org/ver10/error">
      <s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>${sub}</s:Value></s:Subcode></s:Code>
      <s:Reason><s:Text xml:lang="en">Something went wrong</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;
    expect(errorCode(() => parseOnvifStorage(fault("ter:NotAuthorized")))).toBe("AUTH_FAILED");
    expect(errorCode(() => parseOnvifStorage(fault("ter:OperationProhibited")))).toBe("PERMISSION_DENIED");
    expect(errorCode(() => parseOnvifStorage(fault("ter:ActionNotSupported")))).toBe("API_UNAVAILABLE");
    expect(errorCode(() => parseOnvifStorage(fault("ter:InvalidArgVal")))).toBe("API_ERROR");
    expect(errorCode(() => parseOnvifStorage("<not-closed>"))).toBe("INVALID_RESPONSE");
    expect(errorCode(() => parseOnvifStorage("<root/>"))).toBe("INVALID_RESPONSE");
  });
});
