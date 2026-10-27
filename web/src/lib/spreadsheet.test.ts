import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readTabText, readXlsx, toImportRecords } from "./spreadsheet";

describe("camera lists from spreadsheets", () => {
  it("reads a Bosch Project Assistant workbook as Bosch cameras", async () => {
    const sheets = await readXlsx(new Uint8Array(readFileSync(`${process.cwd()}/src/lib/__fixtures__/bosch-project-assistant.xlsx`)));
    expect(sheets.map((s) => s.name)).toEqual(["Instructions", "Template - populate data here"]);
    const found = sheets.map((s) => toImportRecords(s.rows)).find((r) => r !== null)!;
    expect(found.format).toBe("bosch");
    expect(found.records).toEqual([
      { name: "Entrance", ip: "10.20.0.11", brand: "Bosch", model: "NDE-8504-R", username: "service", password: "ServicePwd1!", location: "Ground floor, main door", port: "", protocol: "" },
      { name: "Car park", ip: "10.20.0.12", brand: "Bosch", model: "NBN-73023-BA", username: "", password: "", location: "", port: "", protocol: "" },
    ]);
  });

  it("reads Excel's Unicode Text export (UTF-16, tab-separated)", () => {
    const text = "﻿Camera name [name]\tIP address [ip]\tCommercial type number [ctn]\r\nLobby\t10.20.0.13\tNDE-3502-AL\r\n";
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) [bytes[2 * i], bytes[2 * i + 1]] = [text.charCodeAt(i) & 255, text.charCodeAt(i) >> 8];
    expect(toImportRecords(readTabText(bytes))!.records[0]).toMatchObject({ name: "Lobby", ip: "10.20.0.13", brand: "Bosch", model: "NDE-3502-AL" });
  });

  it("reads the app's own columns, and nothing else", () => {
    expect(toImportRecords([["Name", "IP", "Brand", "Port"], ["Gate", "10.0.0.5", "Hikvision", "8080"]])!.records[0]).toMatchObject({ name: "Gate", ip: "10.0.0.5", brand: "Hikvision", port: "8080" });
    expect(toImportRecords([["Title"], ["x"]])).toBeNull();
  });
});
