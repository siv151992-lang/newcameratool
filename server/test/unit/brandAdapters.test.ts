import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AXIS_DEVICE_INFO_PATH, AXIS_STORAGE_PATH, AxisAdapter } from "../../src/integrations/axis/adapter.js";
import { DAHUA_DEVICE_INFO_PATH, DAHUA_RECORDING_PATH, DAHUA_STORAGE_PATH, DahuaAdapter } from "../../src/integrations/dahua/adapter.js";
import { HANWHA_DEVICE_INFO_PATH, HANWHA_EVENT_STATUS_PATH, HANWHA_RECORDING_SETTINGS_PATH, HANWHA_STORAGE_PATH, HanwhaAdapter } from "../../src/integrations/hanwha/adapter.js";
import {
  HIKVISION_RECORDING_PATH,
  HIKVISION_SEARCH_PATH,
  HIKVISION_TIME_PATH,
  HIKVISION_TRACK_PATH,
  HikvisionAdapter,
} from "../../src/integrations/hikvision/adapter.js";
import { CameraHttpClient } from "../../src/integrations/http/cameraHttpClient.js";
import { requireOk } from "../../src/integrations/http/responses.js";
import { PANASONIC_INFO_PATH, PANASONIC_SDCARD_PATH, PanasonicAdapter } from "../../src/integrations/panasonic/adapter.js";
import { ONVIF_DEVICE_SERVICE_PATH, ONVIF_RECORDING_SERVICE_PATH, OnvifAdapter } from "../../src/integrations/onvif/adapter.js";
import { MIB } from "../../src/integrations/parsing.js";
import { createRegistry } from "../../src/integrations/registry.js";
import { CameraApiError, type CameraConfig } from "../../src/integrations/types.js";
import { UNIVIEW_DEVICE_INFO_PATH, UNIVIEW_LEGACY_STORAGE_PATH, UNIVIEW_RECORDING_PATH, UNIVIEW_STORAGE_PATH, UniviewAdapter } from "../../src/integrations/uniview/adapter.js";
import { IPC815SB_CONTAINERS, ipc815sbNotSupported } from "../fixtures/uniview-ipc815sb.js";
import { readRecording } from "../../src/monitoring/checkService.js";
import { HostGuard } from "../../src/security/hostGuard.js";
import { cameraTime, DS2CD2563G2_SEARCH_UTC, DS2CD3563G2_RECORDING_STATUS_404, DS2CD3563G2_SEARCH, DS2CD3563G2_TRACK, SEARCH_NO_MATCHES } from "../fixtures/hikvision-ds2cd3563g2.js";
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
    for (const key of ["hikvision", "prama", "dahua", "axis", "uniview", "onvif", "hanwha", "panasonic"]) expect(registry.isSupported(key)).toBe(true);
    for (const key of ["hikvision", "prama", "hanwha", "panasonic"]) expect(registry.get(key).meta.supportStatus).toBe("supported");
    for (const key of ["dahua", "axis", "uniview", "onvif"]) expect(registry.get(key).meta.supportStatus).toBe("unverified");
    expect(registry.list().map((b) => b.key)).toEqual(["hikvision", "prama", "dahua", "axis", "uniview", "onvif", "hanwha", "panasonic", "reolink", "bosch", "milestone"]);
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
    .route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: IPC815SB_CONTAINERS })
    .route(UNIVIEW_LEGACY_STORAGE_PATH, {
      contentType: "application/json",
      body: lapi({ Disks: [{ ID: 1, Name: "sdcard0", Status: "Normal", Type: "Local", TotalCapacity: 128000, UsedCapacity: 64500, FreeCapacity: 63500 }] }),
    })
    .route(UNIVIEW_DEVICE_INFO_PATH, {
      contentType: "application/json",
      body: lapi({ DeviceModel: "IPC322LB-SF28-A", SerialNumber: "210235C3EN3191000123", FirmwareVersion: "IPC_Q1201-B5005P20D1907", MAC: "48:ea:63:00:00:01" }),
    });
  const ctx = useCamera(cam);
  const adapter = new UniviewAdapter(http);
  beforeEach(() => {
    cam.route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: IPC815SB_CONTAINERS });
  });

  it("reads the SD card from Storage/Containers/DetailInfos (real IPC815SB-ADF14K-I0 reply)", async () => {
    const r = await adapter.getStorageStatus(ctx.config);
    expect(r).toMatchObject({ totalBytes: 243712 * MIB, freeBytes: 37298 * MIB });
    expect(r.usedPercentage).toBeCloseTo(84.7, 1);
    expect(r.devices).toEqual([
      expect.objectContaining({ id: "sd-1", name: "SD card 1", type: "SD", healthStatus: "healthy", rawStatus: "Recordable (3)" }),
    ]);
    expect(cam.requests.filter((q) => q.headers.authorization).map((q) => q.path)).toEqual([UNIVIEW_STORAGE_PATH]);
  });

  it("skips empty slots and reports card problems", async () => {
    const body = (status: number) => IPC815SB_CONTAINERS.replace('"Status":\t3', `"Status":\t${status}`);
    cam.route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: body(0) });
    expect((await adapter.getStorageStatus(ctx.config)).devices).toEqual([]); // no card
    cam.route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: body(4) });
    expect((await adapter.getStorageStatus(ctx.config)).devices[0]).toMatchObject({ healthStatus: "unhealthy", rawStatus: "Abnormal (4)" });
    cam.route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: body(9) });
    expect((await adapter.getStorageStatus(ctx.config)).devices[0]).toMatchObject({ healthStatus: "unknown", rawStatus: "Status 9" });
  });

  it("falls back to Storage/Disks on older firmware, and reads device info", async () => {
    cam.route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: ipc815sbNotSupported(UNIVIEW_STORAGE_PATH) });
    expect(await adapter.getStorageStatus(ctx.config)).toMatchObject({ totalBytes: 128000 * MIB, freeBytes: 63500 * MIB });
    expect(await adapter.getDeviceInfo(ctx.config)).toMatchObject({ model: "IPC322LB-SF28-A", macAddress: "48:ea:63:00:00:01" });
    expect(cam.requests.at(-1)!.headers.accept).toContain("application/json");
  });

  it("classifies LAPI status codes, including the real \"UnSupport\" reply", async () => {
    cam.route(UNIVIEW_STORAGE_PATH, { contentType: "application/json", body: ipc815sbNotSupported(UNIVIEW_STORAGE_PATH) });
    cam.route(UNIVIEW_LEGACY_STORAGE_PATH, { contentType: "application/json", body: ipc815sbNotSupported(UNIVIEW_LEGACY_STORAGE_PATH) });
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

  it("falls back to searching Hikvision recordings when the status endpoint is missing", async () => {
    cam.routes.delete("/ISAPI/ContentMgmt/Recording/status");
    cam.route("/ISAPI/System/time", { body: "<Time><localTime>2026-10-21T17:25:00+05:30</localTime></Time>" });
    cam.route("/ISAPI/ContentMgmt/search", {
      body: `<CMSearchResult><responseStatus>true</responseStatus><responseStatusStrg>OK</responseStatusStrg><matchList>
        <searchMatchItem><trackID>101</trackID><timeSpan><startTime>2026-10-21T17:00:00Z</startTime><endTime>2026-10-21T17:24:50Z</endTime></timeSpan></searchMatchItem>
        </matchList></CMSearchResult>`,
    });
    cam.requests.length = 0;
    expect((await new HikvisionAdapter(http).getRecordingStatus(ctx.config)).state).toBe("recording");
    const search = cam.requests.find((r) => r.headers.authorization && r.path === "/ISAPI/ContentMgmt/search");
    expect(search).toMatchObject({ method: "POST" });
    expect(search!.body).toContain("<startTime>2026-10-21T16:55:00Z</startTime>"); // 30 minutes back
  });

  it("is reported as unknown by the monitor when the endpoint is missing, without failing", async () => {
    cam.routes.delete(DAHUA_RECORDING_PATH);
    const r = await readRecording(new DahuaAdapter(http), ctx.config);
    expect(r).toMatchObject({ state: "unknown", channels: [] });
    expect(r.detail).toMatch(/does not report recording status/);
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
    const req = cam.requests.find((q) => q.path === ONVIF_RECORDING_SERVICE_PATH)!;
    expect(req.headers["content-type"]).toContain('action="http://www.onvif.org/ver10/recording/wsdl/GetRecordingJobs"');
  });
});

describe("OnvifAdapter service discovery and recording summary", () => {
  const env = (inner: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tse="http://www.onvif.org/ver10/search/wsdl" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ter="http://www.onvif.org/ver10/error"><s:Body>${inner}</s:Body></s:Envelope>`;
  const at = (ms: number) => { const d = new Date(ms); return `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>`; };
  const NOW = Date.UTC(2026, 9, 22, 8, 0, 0);
  let jobs = "Active";
  const cam = new MockBrandCamera();
  cam.auth = "ws-security";
  const soap = (body: string) => ({ contentType: "application/soap+xml", body: env(body) });
  // A token made with the wrong clock is refused, as real cameras do; the adapter retries with the camera's clock.
  const denied = { status: 400, ...soap(`<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason></s:Fault>`) };
  cam.route(ONVIF_DEVICE_SERVICE_PATH, (req: MockRequest) => {
    if (req.body.includes("GetSystemDateAndTime")) {
      // Camera on UTC+05:30
      return soap(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>${at(NOW)}</tt:UTCDateTime><tt:LocalDateTime>${at(NOW + 330 * 60_000)}</tt:LocalDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
    }
    if (!cam.verifyToken(req.body, NOW)) return denied;
    return soap(`<tds:GetServicesResponse>` +
      `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/recording/wsdl</tds:Namespace><tds:XAddr>http://10.10.24.160/onvif/Recording</tds:XAddr></tds:Service>` +
      `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/search/wsdl</tds:Namespace><tds:XAddr>http://10.10.24.160/onvif/Search</tds:XAddr></tds:Service>` +
      `</tds:GetServicesResponse>`);
  });
  cam.route("/onvif/Recording", (req: MockRequest) =>
    cam.verifyToken(req.body, NOW)
      ? soap(`<trc:GetRecordingJobsResponse><trc:JobItem><trc:JobToken>job1</trc:JobToken><trc:JobConfiguration><tt:RecordingToken>rec1</tt:RecordingToken><tt:Mode>${jobs}</tt:Mode></trc:JobConfiguration></trc:JobItem></trc:GetRecordingJobsResponse>`)
      : denied,
  );
  cam.route("/onvif/Search", (req: MockRequest) =>
    cam.verifyToken(req.body, NOW)
      ? soap(`<tse:GetRecordingSummaryResponse><tse:Summary><tt:DataFrom>2026-09-22T02:30:00Z</tt:DataFrom><tt:DataUntil>2026-10-22T07:59:00Z</tt:DataUntil><tt:NumberRecordings>1</tt:NumberRecordings></tse:Summary></tse:GetRecordingSummaryResponse>`)
      : denied,
  );
  const ctx = useCamera(cam);

  it("uses the service paths the camera lists, and reads days of recordings in the camera's local time", async () => {
    const onvif = new OnvifAdapter(http);
    // Our clock differs from the camera's: the token is retried with the camera's clock.
    expect((await onvif.getRecordingStatus(ctx.config)).state).toBe("recording");
    expect(await onvif.getRecordingRange(ctx.config)).toEqual({ oldest: "2026-09-22T08:00:00", days: 30.23 });
    expect(cam.requests.some((q) => q.path === "/onvif/Search")).toBe(true);
  });

  it("serves Uniview recording over ONVIF when LAPI does not report it", async () => {
    cam.route(UNIVIEW_RECORDING_PATH, { contentType: "application/json", body: ipc815sbNotSupported(UNIVIEW_RECORDING_PATH) });
    jobs = "Idle";
    const r = await new UniviewAdapter(http).getRecordingStatus(ctx.config);
    expect(r.state).toBe("idle");
    expect(r.detail).toContain("read over ONVIF");
    expect((await new UniviewAdapter(http).getRecordingRange(ctx.config))?.days).toBe(30.23);
    jobs = "Active";
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

describe("Hikvision recording from the recordings on storage (DS-2CD3563G2-IS)", () => {
  // Real replies: Recording/status is 404; the newest segment ends at 13:22:18 camera time.
  let localTime = "2026-10-21T13:25:02+05:30";
  let search = (_body: string) => DS2CD3563G2_SEARCH;
  let track = DS2CD3563G2_TRACK();
  const cam = new MockBrandCamera()
    .route(HIKVISION_RECORDING_PATH, { status: 404, contentType: "text/html", body: DS2CD3563G2_RECORDING_STATUS_404 })
    .route(HIKVISION_TIME_PATH, () => ({ body: cameraTime(localTime), contentType: "application/xml" }))
    .route(HIKVISION_SEARCH_PATH, (req) => ({ body: search(req.body), contentType: "application/xml" }))
    .route(HIKVISION_TRACK_PATH, () => ({ body: track, contentType: "application/xml" }));
  const ctx = useCamera(cam);
  const read = () => new HikvisionAdapter(http).getRecordingStatus(ctx.config);
  beforeEach(() => {
    localTime = "2026-10-21T13:25:02+05:30";
    search = () => DS2CD3563G2_SEARCH;
    track = DS2CD3563G2_TRACK();
  });

  it("is recording when the newest segment ended within minutes, on the camera's own clock", async () => {
    const r = await read();
    expect(r).toMatchObject({ state: "recording", detail: expect.stringContaining("last recorded 3 min ago, 13:22 camera time") });
    const post = cam.requests.find((q) => q.path === HIKVISION_SEARCH_PATH)!;
    expect(post.method).toBe("POST");
    // The window is in camera wall-clock time: 30 minutes before to 5 minutes after its "now".
    expect(post.body).toContain("<startTime>2026-10-21T12:55:02Z</startTime><endTime>2026-10-21T13:30:02Z</endTime>");
    expect(post.body).toContain("<trackID>101</trackID>");
    expect(cam.requests.some((q) => q.path === HIKVISION_TRACK_PATH)).toBe(false); // not needed
  });

  it("reports continuous recording that stopped as an error", async () => {
    localTime = "2026-10-21T14:10:00+05:30"; // Wednesday, scheduled CMR all day
    const r = await read();
    expect(r.state).toBe("error");
    expect(r.detail).toContain("Continuous recording is scheduled, but nothing recorded in the last 10 minutes; last recording ended at 13:22 camera time");
  });

  it("is not recording when recording is off for the channel", async () => {
    localTime = "2026-10-21T18:00:00+05:30";
    search = () => SEARCH_NO_MATCHES;
    track = DS2CD3563G2_TRACK("false");
    expect(await read()).toMatchObject({ state: "idle", detail: expect.stringContaining("Recording is turned off for this channel") });
  });

  it("tries UTC search times for firmware that uses them", async () => {
    // Local 18:52 (+05:30) = 13:22 UTC; only a search around 13:22 finds the segment.
    localTime = "2026-10-21T18:53:00+05:30";
    search = (body) => (body.includes("<startTime>2026-10-21T12:53:00Z") ? DS2CD3563G2_SEARCH : SEARCH_NO_MATCHES);
    expect((await read()).state).toBe("recording");
    expect(cam.requests.filter((q) => q.path === HIKVISION_SEARCH_PATH && q.headers.authorization)).toHaveLength(2);
  });

  it("reads replies in UTC from firmware that answers that way (DS-2CD2563G2-IS)", async () => {
    localTime = "2026-10-21T19:14:19+05:30";
    search = () => DS2CD2563G2_SEARCH_UTC; // 13:42:42Z = 19:12:42 local
    expect(await read()).toMatchObject({ state: "recording", detail: expect.stringContaining("last recorded 2 min ago, 19:12 camera time") });
  });

  it("falls back when Recording/status is refused with 403, and names a refused search", async () => {
    cam.route(HIKVISION_RECORDING_PATH, { status: 403, contentType: "text/html", body: "Forbidden" });
    try {
      expect((await read()).state).toBe("recording");
      cam.route(HIKVISION_SEARCH_PATH, { status: 403, contentType: "text/html", body: "Forbidden" });
      const r = await readRecording(new HikvisionAdapter(http), ctx.config);
      expect(r.state).toBe("unknown");
      expect(r.detail).toContain("(while searching its recordings). Give the camera user the Remote: Playback permission");
    } finally {
      cam.route(HIKVISION_RECORDING_PATH, { status: 404, contentType: "text/html", body: DS2CD3563G2_RECORDING_STATUS_404 });
      cam.route(HIKVISION_SEARCH_PATH, (req) => ({ body: search(req.body), contentType: "application/xml" }));
    }
  });

  it("reports days of recordings from the oldest segment, local-time replies (DS-2CD3563G2-IS)", async () => {
    // Oldest segment starts 2026-10-20 19:56:02; camera time 2026-10-21 13:25:02 → 0.73 days.
    expect(await new HikvisionAdapter(http).getRecordingRange(ctx.config)).toEqual({ oldest: "2026-10-20T19:56:02", days: 0.73 });
    const posts = cam.requests.filter((q) => q.path === HIKVISION_SEARCH_PATH && q.headers.authorization);
    expect(posts[0]!.body).toContain("<startTime>2025-09-16T13:25:02Z</startTime>"); // 400 days back
    expect(posts[0]!.body).toContain("<maxResults>5</maxResults>");
  });

  it("reports days of recordings for firmware that replies in UTC (DS-2CD2563G2-IS)", async () => {
    localTime = "2026-10-21T19:14:19+05:30";
    search = () => DS2CD2563G2_SEARCH_UTC; // oldest 2026-10-20T20:18:27Z = 2026-10-21 01:48:27 local
    expect(await new HikvisionAdapter(http).getRecordingRange(ctx.config)).toEqual({ oldest: "2026-10-21T01:48:27", days: 0.73 });
  });

  it("reports no range when the card holds no recordings", async () => {
    search = () => SEARCH_NO_MATCHES;
    expect(await new HikvisionAdapter(http).getRecordingRange(ctx.config)).toBeNull();
  });

  it("still prefers Recording/status where the camera provides it", async () => {
    const live = new MockBrandCamera().route(HIKVISION_RECORDING_PATH, { body: "<RecordingStatus><status>recording</status></RecordingStatus>" });
    const port = await live.start();
    try {
      expect((await new HikvisionAdapter(http).getRecordingStatus({ ...ctx.config, port })).state).toBe("recording");
      expect(live.requests.map((q) => q.path)).not.toContain(HIKVISION_SEARCH_PATH);
    } finally {
      await live.stop();
    }
  });
});
