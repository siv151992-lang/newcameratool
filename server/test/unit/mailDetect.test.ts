import { describe, expect, it } from "vitest";
import { detectMailServer } from "../../src/services/mailDetect.js";

const mx = (...hosts: string[]) => async () => hosts.map((exchange, priority) => ({ exchange, priority }));

describe("mail server detection", () => {
  it("recognises Zoho Mail in each data centre, for company domains and Zoho addresses", async () => {
    expect(await detectMailServer("alerts@zohocorp.com", mx("mx.zoho.com", "mx2.zoho.com"))).toMatchObject({ smtpHost: "smtppro.zoho.com", smtpPort: 465, smtpSecure: true });
    expect(await detectMailServer("cctv@estancia.in", mx("mx.zoho.in."))).toMatchObject({ provider: "Zoho Mail India", smtpHost: "smtppro.zoho.in" });
    expect(await detectMailServer("me@zoho.eu", mx())).toMatchObject({ smtpHost: "smtp.zoho.eu" });
    expect(await detectMailServer("me@zohomail.in", mx())).toMatchObject({ smtpHost: "smtp.zoho.in" });
  });

  it("recognises Google Workspace and Microsoft 365", async () => {
    expect(await detectMailServer("a@company.com", mx("aspmx.l.google.com"))).toMatchObject({ smtpHost: "smtp.gmail.com", smtpPort: 465 });
    expect(await detectMailServer("a@gmail.com", mx())).toMatchObject({ smtpHost: "smtp.gmail.com" });
    expect(await detectMailServer("a@company.com", mx("company-com.mail.protection.outlook.com"))).toMatchObject({ smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecure: false });
  });

  it("returns nothing it cannot recognise", async () => {
    expect(await detectMailServer("a@company.com", mx("mail.company.com"))).toBeNull();
    expect(await detectMailServer("a@nowhere.invalid", async () => { throw new Error("ENOTFOUND"); })).toBeNull();
    expect(await detectMailServer("not-an-address", mx("mx.zoho.com"))).toBeNull();
  });
});
