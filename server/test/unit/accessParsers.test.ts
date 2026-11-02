import { describe, expect, it } from "vitest";
import { deviceOnline, parseBioStarEvents } from "../../src/integrations/access/biostar2.js";
import { categorize, samePath } from "../../src/integrations/access/common.js";
import { fromFlags, fromGallagherEvent } from "../../src/integrations/access/gallagher.js";
import { parseAcsEvents, parseWorkStatus } from "../../src/integrations/access/hikvisionAccess.js";
import type { CameraConfig } from "../../src/integrations/types.js";

describe("access control readings", () => {
  it("tells granted from denied, doors, tamper and faults by their words", () => {
    expect(categorize("VERIFY SUCCESS CARD")).toBe("granted");
    expect(categorize("Card authorised")).toBe("granted");
    expect(categorize("Card not authorised")).toBe("denied");
    expect(categorize("identify fail face")).toBe("denied");
    expect(categorize("Door forced open")).toBe("door");
    expect(categorize("TAMPER ON")).toBe("tamper");
    expect(categorize("Controller offline")).toBe("fault");
    expect(categorize("User enrolled")).toBe("other");
  });

  it("reads a Hikvision work status: lock, contact, readers and tamper", () => {
    const points = parseWorkStatus({ AcsWorkStatus: { doorLockStatus: [0, 1], magneticStatus: [0, 3], cardReaderOnlineStatus: [1, 0], cardReaderAntiDismantleStatus: [0, 1], hostAntiDismantleStatus: "close" } }, "Gate");
    expect(points).toEqual([
      { kind: "controller", externalId: "0", name: "Gate", online: true, tamper: false },
      { kind: "door", externalId: "1", name: "Door 1", doorState: "closed", lockState: "locked" },
      { kind: "door", externalId: "2", name: "Door 2", doorState: undefined, lockState: "unlocked", statusText: "door contact broken circuit" },
      { kind: "reader", externalId: "1", name: "Reader 1", online: true, tamper: false },
      { kind: "reader", externalId: "2", name: "Reader 2", online: false, tamper: true },
    ]);
    const { events, doors } = parseAcsEvents({ AcsEvent: { InfoList: [
      { major: 5, minor: 76, time: "2026-11-01T09:00:02+05:30", name: "Asha", doorNo: 1, serialNo: 8 },
      { major: 5, minor: 28, time: "2026-11-01T09:00:01+05:30", doorNo: 2, serialNo: 7 },
      { major: 5, minor: 200, time: "2026-11-01T09:00:03+05:30", serialNo: 9 },
    ] } });
    expect(events.map((e) => [e.category, e.description, e.key])).toEqual([["door", "Door held open too long", "sn:7"], ["denied", "Face refused", "sn:8"], ["other", "Event 5/200", "sn:9"]]);
    expect(events[0]!.at).toBe(Date.parse("2026-11-01T03:30:01Z"));
    expect(doors.get("2")).toBe("held_open");
  });

  it("reads BioStar 2 statuses and events, with door and tamper states from them", () => {
    expect([deviceOnline("1"), deviceOnline("0"), deviceOnline("normal"), deviceOnline("7")]).toEqual([true, false, true, undefined]);
    const names = new Map([["21504", "DOOR_FORCED_OPEN"], ["25344", "TAMPER_ON"], ["4865", "IDENTIFY_SUCCESS_FACE"]]);
    const r = parseBioStarEvents({ EventCollection: { rows: [
      { id: "3", datetime: "2026-11-01T04:00:03.000Z", event_type_id: { code: "25344" }, device_id: { id: "9", name: "Lobby" } },
      { id: "2", datetime: "2026-11-01T04:00:02.000Z", event_type_id: { code: "21504" }, device_id: { id: "9" }, door_id: [{ id: "1", name: "Lobby door" }] },
      { id: "1", datetime: "2026-11-01T04:00:01.000Z", event_type_id: { code: "4865" }, device_id: { id: "9", name: "Lobby" }, user_id: { user_id: "5", name: "Ravi" } },
    ] } }, names);
    expect(r.events.map((e) => [e.category, e.description, e.person ?? null, e.point])).toEqual([
      ["granted", "Identify success face", "Ravi", "Lobby"],
      ["door", "Door forced open", null, "Lobby door"],
      ["tamper", "Tamper on", null, "Lobby"],
    ]);
    expect(r.doors.get("1")).toBe("forced");
    expect(r.tamper.get("9")).toBe(true);
  });

  it("reads Gallagher status flags and events", () => {
    expect(fromFlags("door", { id: "1", name: "Front", statusFlags: ["forced", "open", "unlocked"] })).toMatchObject({ doorState: "forced", lockState: "unlocked", online: true, tamper: false });
    expect(fromFlags("reader", { id: "2", name: "T15", statusFlags: ["controllerOffline", "tamper"] })).toMatchObject({ online: false, tamper: true });
    expect(fromFlags("reader", { id: "3", name: "T20" })).toEqual({ kind: "reader", externalId: "3", name: "T20" });
    // Per the REST reference: "secure" is not "locked", "unknown" is not offline, and a door is online only when open or closed.
    expect(fromFlags("door", { id: "4", name: "Back", statusFlags: ["closed", "unlocked", "secure"] })).toMatchObject({ online: true, doorState: "closed", lockState: "unlocked" });
    expect(fromFlags("door", { id: "5", name: "Side", statusFlags: ["unknown"] })).toEqual({ kind: "door", externalId: "5", name: "Side" });
    expect(fromFlags("door", { id: "6", name: "Dock", statusFlags: ["deviceNotResponding"] })).toMatchObject({ online: false });
    expect(fromFlags("controller", { id: "7", name: "C6000", statusFlags: ["notPolled"] })).toMatchObject({ online: undefined, statusText: expect.stringMatching(/Shunted/) });
    expect(fromFlags("controller", { id: "8", name: "C7000", statusFlags: [] }, true)).toMatchObject({ online: true, tamper: false });
    expect(fromGallagherEvent({ id: "9", time: "2026-11-01T04:00:00Z", type: { name: "Card not authorised" }, group: { name: "Card Event" }, cardholder: { firstName: "Mei", lastName: "Lin" }, door: { name: "Front" } }))
      .toMatchObject({ category: "denied", person: "Mei Lin", point: "Front", key: "9" });
  });

  it("follows the system's own links only on the same host", () => {
    const cam = { host: "10.0.0.5", port: 8904, protocol: "https" } as CameraConfig;
    expect(samePath(cam, "https://10.0.0.5:8904/api/doors?top=1000&pos=1000")).toBe("/api/doors?top=1000&pos=1000");
    expect(() => samePath(cam, "https://evil.example/api/doors")).toThrow(/another host/);
  });
});
