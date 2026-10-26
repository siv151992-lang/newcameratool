import { describe, expect, it } from "vitest";
import { requireOk } from "../../src/integrations/http/responses.js";

const res = (location: string) => ({ status: 302, headers: { location }, body: "" });

describe("camera redirects", () => {
  it("says the camera accepts only HTTPS, and what to change", () => {
    expect(() => requireOk(res("https://192.168.1.64/ISAPI/ContentMgmt/Storage"), "/ISAPI/ContentMgmt/Storage"))
      .toThrow("The camera redirects /ISAPI/ContentMgmt/Storage to HTTPS (https://192.168.1.64/ISAPI/ContentMgmt/Storage): it accepts only HTTPS. Edit the camera and set Protocol to HTTPS (port 443)");
  });

  it("recognises the web login page", () => {
    expect(() => requireOk(res("/doc/page/login.asp?_1700000000"), "/ISAPI/System/deviceInfo")).toThrow(/redirected \/ISAPI\/System\/deviceInfo to its web login page \(\/doc\/page\/login\.asp\)/);
  });

  it("names any other redirect", () => {
    expect(() => requireOk(res("http://10.0.0.9:8080/x"), "/a")).toThrow("The camera redirected /a to http://10.0.0.9:8080/x (HTTP 302) instead of answering it.");
  });
});

describe("Dahua / CP Plus with CGI turned off", () => {
  it("says to turn on CGI when every /cgi-bin path is 404", async () => {
    const { DahuaAdapter } = await import("../../src/integrations/dahua/adapter.js");
    const http = { request: async () => ({ status: 404, headers: {}, body: "" }) } as never;
    const camera = { host: "10.0.0.5", port: 443, protocol: "https" as const, username: "admin", password: "x", timeoutMs: 1000 };
    await expect(new DahuaAdapter(http).getDeviceInfo(camera)).rejects.toThrow(/HTTP API \(CGI\) may be turned off.*Access Platform/);
  });
});
