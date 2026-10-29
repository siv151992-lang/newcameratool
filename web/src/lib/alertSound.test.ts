import { describe, expect, it } from "vitest";
import { newAlerts } from "./alertSound";

describe("which alerts are new", () => {
  it("the first look only learns what is open; later, alerts not seen before are new", () => {
    const first = newAlerts(null, [{ id: 1 }, { id: 2 }]);
    expect(first.fresh).toEqual([]);
    const next = newAlerts(first.seen, [{ id: 2 }, { id: 3 }]);
    expect(next.fresh).toEqual([{ id: 3 }]);
    // One resolved and one new at the same time: still heard (a count would not change).
    expect(newAlerts(next.seen, [{ id: 3 }, { id: 4 }]).fresh).toEqual([{ id: 4 }]);
    // An alert that comes back after being resolved is new again.
    const gone = newAlerts(next.seen, [{ id: 3 }]);
    expect(newAlerts(gone.seen, [{ id: 3 }, { id: 2 }]).fresh).toEqual([{ id: 2 }]);
  });
});
