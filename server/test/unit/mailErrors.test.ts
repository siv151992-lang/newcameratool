import { describe, expect, it } from "vitest";
import { explainMailError } from "../../src/notifications/mailer.js";

const zoho = { smtpHost: "smtppro.zoho.com", smtpPort: 587, smtpSecure: true };
const err = (message: string, extra: object = {}) => Object.assign(new Error(message), extra);

describe("mail errors in plain words", () => {
  it("explains SSL on a STARTTLS port", () => {
    const m = explainMailError(err("585265B0:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number"), zoho);
    expect(m).toMatch(/port 587, turn off "Use SSL\/TLS from the start"/);
  });
  it("explains a refused password and an unreachable server", () => {
    expect(explainMailError(err("Invalid login: 535 Authentication Failed", { code: "EAUTH", responseCode: 535 }), zoho)).toMatch(/app password/);
    expect(explainMailError(err("Connection timeout", { code: "ETIMEDOUT" }), { ...zoho, smtpPort: 465 })).toMatch(/outbound port 465/);
    expect(explainMailError(err("getaddrinfo ENOTFOUND smtp.zoho.con", { code: "EDNS" }), zoho)).toMatch(/could not be found/);
  });
  it("keeps other messages as they are", () => {
    expect(explainMailError(err("Something odd"), zoho)).toBe("Something odd");
  });
});
