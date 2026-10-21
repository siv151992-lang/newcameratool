import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AXIS_DEVICE_INFO_PATH, AXIS_STORAGE_PATH, AxisAdapter } from "../../src/integrations/axis/adapter.js";
import { DAHUA_DEVICE_INFO_PATH, DAHUA_RECORDING_PATH, DAHUA_STORAGE_PATH, DahuaAdapter } from "../../src/integrations/dahua/adapter.js";
import { HANWHA_DEVICE_INFO_PATH, HANWHA_EVENT_STATUS_PATH, HANWHA_RECORDING_SETTINGS_PATH, HANWHA_STORAGE_PATH, HanwhaAdapter } from "../../src/integrations/hanwha/adapter.js";
import { HikvisionAdapter } from "../../src/integrations/hikvision/adapter.js";
import { CameraHttpClient } from "../../src/integrations/http/cameraHttpClient.js";
import { requireOk } from "../../src/integrations/http/responses.js";
import { PANASONIC_INFO_PATH, PANASONIC_SDCARD_PATH, PanasonicAdapter } from "../../src/integrations/panasonic/adapter.js";
import { ONVIF_DEVICE_SERVICE_PATH, ONVIF_RECORDING_SERVICE_PATH, OnvifAdapter } from "../../src/integrations/onvif/adapter.js";
import { MIB } from "../../src/integrations/parsing.js";
import { createRegistry } from "../../src/integrations/registry.js";
import { CameraApiError, type CameraConfig } from "../../src/integrations/types.js";
import { UNIVIEW_DEVICE_INFO_PATH, UNIVIEW_RECORDING_PATH, UNIVIEW_STORAGE_PATH, UniviewAdapter } from "../../src/integrations/uniview/adapter.js";
import { readRecording } from "../../src/monitoring/checkService.js";
import { HostGuard } from "../../src/security/hostGuard.js";
import { WV_S35402_GETINFO, WV_S35402_SDCARD_PAGE } from "../fixtures/panasonic-wv-s35402.js";
import { MockBrandCamera, type MockRequest } from "../mockBrandCamera.js";

const http = new CameraHttpClient(new HostGuard({ allowedNetworks: "10.0.0.0/8", allowLoopback: true }));

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "none";
  } catch (e) {
    expect(e).toBeInstanceOf(CameraApiError);
    return (e as CameraApiError).code;
  }
};

/** Starts a mock camera for one describe block and returns a config pointing at it. */
function useCamera(cam: MockBrandCamera) {
  const ctx = { config: undefined as unknown as CameraConfig };
  beforeAll(async () => {
    const port = await cam.start();
    ctx.config = { host: "127.0.0.1", port, protocol: "http", username: "admin", password: "S3cret-pass", timeoutMs: 1500 };
  });
  afterAll(() => cam.stop());
  beforeEach(() => {
    cam.requests = [];
  });
  return ctx;
}

describe("brand registry", () => {
  const registry = createRegistry(http);

  it("registers every brand adapter, new ones as unverified", () => {
    for (const key of ["hikvision", "dahua", "axis", "uniview", "onvif", "hanwha", "panasonic"]) expect(registry.isSupported(key)).toBe(true);
    for (const key of ["hikvision", "hanwha", "panasonic"]) expect(registry.get(key).meta.supportStatus).toBe("supported");
    for (const key of ["dahua", "axis", "uniview", "onvif"]) expect(registry.get(key).meta.supportStatus).toBe("unverified");
    expect(registry.list().map((b) => b.key)).toEqual(["hikvision", "dahua", "axis", "uniview", "onvif", "hanwha", "panasonic"]);
  });

  it("resolves brand aliases", () => {
    expect(registry.resolveKey("CP Plus")).toBe("dahua");
    expect(registry.resolveKey("Amcrest")).toBe("dahua");
    expect(registry.resolveKey("AXIS")).toBe("axis");
    expect(registry.resolveKey("UNV")).toBe("uniview");
    expect(registry.resolveKey("Generic ONVIF")).toBe("onvif");
    expect(registry.resolveKey("acme")).toBeUndefined();
  });
});

describe("requireOk", () => {
  const res = (status: number, body = "") => ({ status, headers: {}, body });
  const fault = () => new CameraApiError("AUTH_FAILED", "nope");

  it("passes 2xx bodies through and classifies failures", () => {
    expect(requireOk(res(200, "ok"), "/x")).toBe("ok");
    expect(() => requireOk(res(404), "/x")).toThrow(expect.objectContaining({ code: "API_UNAVAILABLE" }));
    expect(() => requireOk(res(503), "/x")).toThrow(expect.objectContaining({ code: "API_ERROR", transient: true }));
    // An authentication fault in a 500 body is neither retried nor reported as a server error.
    expect(() => requireOk(res(500), "/x", fault)).toThrow(expect.objectContaining({ code: "AUTH_FAILED", transient: false }));
    expect(() => requireOk(res(404), "/x", () => new CameraApiError("API_ERROR", "e"))).toThrow(
      expect.objectContaining({ code: "API_UNAVAILABLE" }),
    );
  });
});

describe("AxisAdapter", () => {
  const cam = new MockBrandCamera()
    .route(AXIS_STORAGE_PATH, {
      body: "root.Storage.S0.DriveStatus=Normal\r\nroot.Storage.S0.TotalSize=1000\r\nroot.Storage.S0.FreeSize=250\r\nroot.Storage.S0.WearLevel=12\r\n",
    })
    .route(AXIS_DEVICE_INFO_PATH, {
      body: "root.Brand.ProdFullName=AXIS M3106-L Mk II Network Camera\nroot.Brand.ProdNbr=M3106-L Mk II\n" +
        "root.Properties.Firmware.Version=10.12.153\nroot.Properties.System.SerialNumber=ACCC8E123456\n",
    });
  const ctx = useCamera(cam);
  const adapter = new AxisAdapter(http);

  it("reads storage through Digest auth", async () => {
    const r = await adapter.getStorageStatus(ctx.config);
    expect(r).toMatchObject({ totalBytes: 1000 * MIB, freeBytes: 250 * MIB, usedPercentage: 75 });
    expect(cam.requests.map((q) => [q.method, q.path])).toEqual([["GET", AXIS_STORAGE_PATH], ["GET", AXIS_STORAGE_PATH]]);
  });

  it("reads device info", async () => {
    expect(await adapter.getDeviceInfo(ctx.config)).toEqual({
      deviceName: "AXIS M3106-L Mk II Network Camera", model: "M3106-L Mk II", serialNumber: "ACCC8E123456",
      firmwareVersion: "10.12.153", macAddress: "AC:CC:8E:12:34:56",
    });
  });

  it("classifies a missing storage group, wrong passwords and missing endpoints", async () => {
    cam.route(AXIS_STORAGE_PATH, { body: "# Error: Error -1 getting param in group 'Storage'\n" });
    expect(await codeOf(adapter.getStorageStatus(ctx.config))).toBe("API_UNAVAILABLE");
    expect(await codeOf(adapter.getDeviceInfo({ ...ctx.config, password: "wrong" }))).toBe("AUTH_FAILED");
    cam.routes.delete(AXIS_STORAGE_PATH);
    expect(await codeOf(adapter.getStorageStatus(ctx.config))).toBe("API_UNAVAILABLE");
  });
});

describe("DahuaAdapter", () => {
  const cam = new MockBrandCamera()
    .route(DAHUA_STORAGE_PATH, {
      body: "list.info[0].Name=/dev/mmc0\r\nlist.info[0].State=Success\r\nlist.info[0].Detail[0].IsError=false\r\n" +
        "list.info[0].Detail[0].TotalBytes=1000.000000\r\nlist.info[0].Detail[0].UsedBytes=900.000000\r\n",
    })
    .route(DAHUA_DEVICE_INFO_PATH, { body: "deviceType=IPC-HFW2431S\r\nprocessor=SSC327DE\r\nserialNumber=6J0123456789\r\n" });
  const ctx = useCamera(cam);
  const adapter = new DahuaAdapter(http);

  it("reads storage and device info", async () => {
    expect(await adapter.getStorageStatus(ctx.config)).toMatchObject({ totalBytes: 1000, usedBytes: 900, usedPercentage: 90 });
    expect(await adapter.getDeviceInfo(ctx.config)).toMatchObject({ model: "IPC-HFW2431S", serialNumber: "6J0123456789" });
  });

  it("treats 'Bad Request' as an unsupported API", async () => {
    cam.route(DAHUA_STORAGE_PATH, { status: 400, body: "Error\r\nBad Request!\r\n" });
    await expect(adapter.getStorageStatus(ctx.config)).rejects.toMatchObject({ code: "API_UNAVAILABLE", options: { httpStatus: 400 } });
  });

  it("runs step-by-step diagnostics", async () => {
    cam.route(DAHUA_STORAGE_PATH, { body: "list.info.Name=/dev/mmc0\r\nlist.info.State=Absent\r\n" });
    const r = await adapter.testConnection(ctx.config);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "warning"]); // no SD card inserted
  });
});

describe("UniviewAdapter", () => {
  const lapi = (data: unknown, code = 0, text = "Succeed") =>
    JSON.stringify({ Response: { ResponseURL: "/LAPI", CreatedID: -1, ResponseCode: code, StatusCode: code, StatusString: text, Data: data } });
  const cam = new MockBrandCamera()
    .route(UNIVIEW_STORAGE_PATH, {
      contentType: "application/json",
      body: lapi({ Disks: [{ ID: 1, Name: "sdcard0", Status: "Normal", Type: "Local", TotalCapacity: 128000, UsedCapacity: 64500, FreeCapacity: 63500 }] }),
    })
    .route(UNIVIEW_DEVICE_INFO_PATH, {
      contentType: "application/json",
      body: lapi({ DeviceModel: "IPC322LB-SF28-A", SerialNumber: "210235C3EN3191000123", FirmwareVersion: "IPC_Q1201-B5005P20D1907", MAC: "48:ea:63:00:00:01" }),
    });
  const ctx = useCamera(cam);
  const adapter = new UniviewAdapter(http);

  it("reads storage and device info", async () => {
    expect(await adapter.getStorageStatus(ctx.config)).toMatchObject({ totalBytes: 128000 * MIB, freeBytes: 63500 * MIB });
    expect(await adapter.getDeviceInfo(ctx.config)).toMatchObject({ model: "IPC322LB-SF28-A", macAddress: "48:ea:63:00:00:01" });
    expect(cam.requests.at(-1)!.headers.accept).toContain("application/json");
  });

  it("classifies LAPI status codes", async () => {
    cam.route(UNIVIEW_STORAGE_PATH, { body: lapi(null, 4, "Not Support") });
    expect(await codeOf(adapter.getStorageStatus(ctx.config))).toBe("API_UNAVAILABLE");
    cam.route(UNIVIEW_STORAGE_PATH, { status: 500, body: lapi(null, 1, "Failed") });
    await expect(adapter.getStorageStatus(ctx.config)).rejects.toMatchObject({ code: "API_ERROR", transient: true });
  });
});

describe("OnvifAdapter", () => {
  const STORAGE = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tst="http://www.onvif.org/ver10/storage/wsdl">
  <soap:Body><tst:GetStorageDevicesResponse><tst:StorageDevice>
    <tst:Token>StorageToken_SD_Card_1</tst:Token>
    <tst:Configuration><tt:Type>SDCard</tt:Type><tt:Enabled>true</tt:Enabled></tst:Configuration>
    <tst:Status><tt:State>Normal</tt:State><tt:StorageInfo>
      <tt:TotalSpace>64023257088</tt:TotalSpace><tt:FreeSpace>32110247936</tt:FreeSpace><tt:UsedSpace>31913009152</tt:UsedSpace>
    </tt:StorageInfo></tst:Status>
  </tst:StorageDevice></tst:GetStorageDevicesResponse></soap:Body>
</soap:Envelope>`;
  const envelope = (inner: string) =>
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ter="http://www.onvif.org/ver10/error"><s:Body>${inner}</s:Body></s:Envelope>`;
  const NOT_AUTHORIZED = envelope(
    `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code>` +
      `<s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason></s:Fault>`,
  );
  const DEVICE_INFO = envelope(
    `<tds:GetDeviceInformationResponse><tds:Manufacturer>Acme</tds:Manufacturer><tds:Model>Cam-1</tds:Model>` +
      `<tds:FirmwareVersion>1.2.3</tds:FirmwareVersion><tds:SerialNumber>SN1</tds:SerialNumber><tds:HardwareId>HW</tds:HardwareId></tds:GetDeviceInformationResponse>`,
  );
  const systemTime = (ms: number) => {
    const d = new Date(ms);
    return envelope(
      `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:UTCDateTime>` +
        `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>` +
        `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>` +
        `</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
    );
  };

  const cam = new MockBrandCamera();
  cam.auth = "ws-security";
  let clockOffsetMs = 0;
  const deviceNow = () => Date.now() + clockOffsetMs;
  cam.route(ONVIF_DEVICE_SERVICE_PATH, (req: MockRequest) => {
    const xml = (body: string, status = 200) => ({ status, body, contentType: "application/soap+xml" });
    if (req.body.includes("GetSystemDateAndTime")) return xml(systemTime(deviceNow()));
    if (!cam.verifyToken(req.body, deviceNow())) return xml(NOT_AUTHORIZED, 400);
    if (req.body.includes("GetStorageDevices")) return xml(STORAGE);
    if (req.body.includes("GetDeviceInformation")) return xml(DEVICE_INFO);
    return xml(envelope(`<s:Fault><s:Code><s:Value>s:Receiver</s:Value><s:Subcode><s:Value>ter:ActionNotSupported</s:Value></s:Subcode></s:Code></s:Fault>`), 500);
  });
  const ctx = useCamera(cam);
  beforeEach(() => {
    clockOffsetMs = 0;
  });

  it("posts a SOAP 1.2 request with a valid WS-Security token and reads storage", async () => {
    const r = await new OnvifAdapter(http).getStorageStatus(ctx.config);
    expect(r).toMatchObject({ totalBytes: 64023257088, freeBytes: 32110247936, usedBytes: 31913009152 });
    const req = cam.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toContain("application/soap+xml");
    expect(req.headers["content-type"]).toContain('action="http://www.onvif.org/ver10/storage/wsdl/GetStorageDevices"');
    expect(req.body).not.toContain("S3cret-pass");
    expect(cam.requests).toHaveLength(1);
  });

  it("corrects for a camera clock that is an hour ahead, then remembers the offset", async () => {
    clockOffsetMs = 60 * 60 * 1000;
    const adapter = new OnvifAdapter(http);
    expect(await adapter.getDeviceInfo(ctx.config)).toEqual({ deviceName: "Acme Cam-1", model: "Cam-1", serialNumber: "SN1", firmwareVersion: "1.2.3" });
    expect(cam.requests.map((q) => /<tds:(\w+)\/>|<tst:(\w+)\/>/.exec(q.body)?.slice(1).find(Boolean))).toEqual([
      "GetDeviceInformation", "GetSystemDateAndTime", "GetDeviceInformation",
    ]);
    cam.requests = [];
    await adapter.getStorageStatus(ctx.config);
    expect(cam.requests).toHaveLength(1);
  });

  it("reports wrong passwords as non-transient AUTH_FAILED after one clock check", async () => {
    await expect(new OnvifAdapter(http).getStorageStatus({ ...ctx.config, password: "wrong" })).rejects.toMatchObject({
      code: "AUTH_FAILED",
      transient: false,
    });
    expect(cam.requests).toHaveLength(2); // the request and the clock check; no blind retry
  });

  it("runs step-by-step diagnostics", async () => {
    const r = await new OnvifAdapter(http).testConnection(ctx.config);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed"]);
    const bad = await new OnvifAdapter(http).testConnection({ ...ctx.config, password: "wrong" });
    expect(bad.steps.find((s) => s.key === "authentication")?.status).toBe("failed");
  });
});

describe("getRecordingStatus over HTTP", () => {
  const cam = new MockBrandCamera()
    .route("/ISAPI/ContentMgmt/Recording/status", { body: "<RecordingStatus><status>idle</status></RecordingStatus>" })
    .route(AXIS_STORAGE_PATH, { body: "root.Storage.S0.DriveStatus=Normal\nroot.Storage.S0.RecordingStatus=Recording\n" })
    .route(DAHUA_RECORDING_PATH, { body: "status.Channels[0].RecordStatus=0\r\nstatus.Channels[0].Mode=Schedule\r\n" })
    .route(UNIVIEW_RECORDING_PATH, { contentType: "application/json", body: JSON.stringify({ Response: { RecordingStatus: "True" } }) });
  const ctx = useCamera(cam);

  it("reads each brand's endpoint through Digest auth", async () => {
    expect((await new HikvisionAdapter(http).getRecordingStatus(ctx.config)).state).toBe("idle");
    expect((await new AxisAdapter(http).getRecordingStatus(ctx.config)).state).toBe("recording");
    expect((await new DahuaAdapter(http).getRecordingStatus(ctx.config)).state).toBe("idle");
    expect((await new UniviewAdapter(http).getRecordingStatus(ctx.config)).state).toBe("recording");
    expect(cam.requests.filter((r) => r.headers.authorization).map((r) => r.path)).toEqual([
      "/ISAPI/ContentMgmt/Recording/status", AXIS_STORAGE_PATH, DAHUA_RECORDING_PATH, UNIVIEW_RECORDING_PATH,
    ]);
  });

  it("is reported as unknown by the monitor when the endpoint is missing, without failing", async () => {
    cam.routes.delete(DAHUA_RECORDING_PATH);
    const r = await readRecording(new DahuaAdapter(http), ctx.config);
    expect(r).toMatchObject({ state: "unknown", channels: [] });
    expect(r.detail).toMatch(/could not be read/);
    const unsupported = { meta: {} } as unknown as Parameters<typeof readRecording>[0];
    expect((await readRecording(unsupported, ctx.config)).detail).toMatch(/not available for this brand/);
  });
});

describe("OnvifAdapter recording jobs", () => {
  const cam = new MockBrandCamera();
  cam.auth = "ws-security";
  cam.route(ONVIF_RECORDING_SERVICE_PATH, (req: MockRequest) => {
    if (!cam.verifyToken(req.body)) return { status: 400, body: "<bad/>" };
    return {
      contentType: "application/soap+xml",
      body: `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl"><s:Body>` +
        `<trc:GetRecordingJobsResponse><trc:JobItem><trc:JobToken>JobToken_01</trc:JobToken><trc:RecordingToken>RecordingToken_01</trc:RecordingToken>` +
        `<trc:RecordingStatus>Recording</trc:RecordingStatus></trc:JobItem></trc:GetRecordingJobsResponse></s:Body></s:Envelope>`,
    };
  });
  const ctx = useCamera(cam);

  it("posts GetRecordingJobs to the recording service", async () => {
    expect((await new OnvifAdapter(http).getRecordingStatus(ctx.config)).state).toBe("recording");
    const req = cam.requests[0]!;
    expect(req.path).toBe(ONVIF_RECORDING_SERVICE_PATH);
    expect(req.headers["content-type"]).toContain('action="http://www.onvif.org/ver10/recording/wsdl/GetRecordingJobs"');
  });
});

describe("HanwhaAdapter", () => {
  const cam = new MockBrandCamera()
    .route(HANWHA_STORAGE_PATH, { body: "Storage.0.Type=MicroSD\r\nStorage.0.Status=Normal\r\nStorage.0.TotalSpace=1000\r\nStorage.0.FreeSpace=250\r\n", contentType: "text/plain" })
    .route(HANWHA_DEVICE_INFO_PATH, { body: "Model=XNV-8080R\r\nSerialNumber=ZM1234\r\nFirmwareVersion=2.21.02\r\n", contentType: "text/plain" });
  const ctx = useCamera(cam);
  const adapter = new HanwhaAdapter(http);

  it("infers recording status; the event status request is optional", async () => {
    cam.route(HANWHA_RECORDING_SETTINGS_PATH, { body: "Enable=True\r\nOverWrite=True\r\n" });
    cam.route(HANWHA_EVENT_STATUS_PATH, { body: "SystemEvent.SDFail=True\r\n" });
    expect(await adapter.getRecordingStatus(ctx.config)).toMatchObject({ state: "error" });
    cam.routes.delete(HANWHA_EVENT_STATUS_PATH);
    expect(await adapter.getRecordingStatus(ctx.config)).toMatchObject({ state: "recording" });
  });

  it("reads storage and device info through Digest auth", async () => {
    expect(await adapter.getStorageStatus(ctx.config)).toMatchObject({ totalBytes: 1000 * MIB, freeBytes: 250 * MIB, usedPercentage: 75 });
    expect(await adapter.getDeviceInfo(ctx.config)).toMatchObject({ model: "XNV-8080R", firmwareVersion: "2.21.02" });
    const r = await adapter.testConnection(ctx.config);
    expect(r.ok).toBe(true);
  });

  it("classifies unsupported submenus, wrong passwords and missing endpoints", async () => {
    cam.route(HANWHA_STORAGE_PATH, { body: "NG\r\nError Code: 600\r\nError Details: Submenu Not Found\r\n" });
    expect(await codeOf(adapter.getStorageStatus(ctx.config))).toBe("API_UNAVAILABLE");
    expect(await codeOf(adapter.getDeviceInfo({ ...ctx.config, password: "wrong" }))).toBe("AUTH_FAILED");
    cam.routes.delete(HANWHA_STORAGE_PATH);
    expect(await codeOf(adapter.getStorageStatus(ctx.config))).toBe("API_UNAVAILABLE");
  });

  it("is registered under its names", () => {
    const r = createRegistry(http);
    for (const name of ["Hanwha", "Wisenet", "Hanwha Vision", "Samsung Techwin"]) expect(r.resolveKey(name), name).toBe("hanwha");
  });
});

describe("PanasonicAdapter", () => {
  const cam = new MockBrandCamera()
    .route(PANASONIC_SDCARD_PATH, { body: WV_S35402_SDCARD_PAGE, contentType: "text/html" })
    .route(PANASONIC_INFO_PATH, { body: WV_S35402_GETINFO, contentType: "text/plain" });
  const ctx = useCamera(cam);
  const adapter = new PanasonicAdapter(http);

  it("reads storage, device info and recording through Digest auth", async () => {
    expect(await adapter.getStorageStatus(ctx.config)).toMatchObject({ totalBytes: 243952 * MIB, freeBytes: 696 * MIB });
    expect(await adapter.getDeviceInfo(ctx.config)).toMatchObject({ model: "WV-S35402-F2L" });
    expect(await adapter.getRecordingStatus(ctx.config)).toMatchObject({ state: "recording" });
    expect((await adapter.testConnection(ctx.config)).ok).toBe(true);
  });

  it("classifies wrong passwords and a missing SD page", async () => {
    expect(await codeOf(adapter.getStorageStatus({ ...ctx.config, password: "wrong" }))).toBe("AUTH_FAILED");
    cam.routes.delete(PANASONIC_SDCARD_PATH);
    expect(await codeOf(adapter.getStorageStatus(ctx.config))).toBe("API_UNAVAILABLE");
  });

  it("is registered under its names", () => {
    const r = createRegistry(http);
    for (const name of ["Panasonic", "i-PRO", "iPRO", "Panasonic i-PRO"]) expect(r.resolveKey(name), name).toBe("panasonic");
  });
});
