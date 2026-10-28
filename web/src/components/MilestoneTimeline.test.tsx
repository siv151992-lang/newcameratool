import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MilestoneTimeline } from "./MilestoneTimeline";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const day = Date.UTC(2026, 9, 29);

beforeAll(() => {
  // jsdom has no layout: an 800 px wide timeline.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
});
afterEach(cleanup);

const labels = () => [...screen.getByRole("slider").querySelectorAll("span")].map((s) => s.textContent);
const timeline = (time: number) =>
  render(<MilestoneTimeline time={time} span={HOUR} min={day - DAY} max={day + DAY} segments={[]} onSeek={() => {}} onScrub={() => {}} />);

describe("timeline like XProtect's", () => {
  it("keeps the playhead in the middle, with its time, and names each day in view", () => {
    timeline(day);
    // At midnight the half before is the day before, named in the date band.
    expect(labels()).toEqual(expect.arrayContaining(["Wed 28-10-2026", "Thu 29-10-2026", "23:50"]));
    expect(labels().at(-1)).toBe("00:00:00");
    expect((screen.getByRole("slider").lastElementChild as HTMLElement).className).toContain("left-1/2");
  });

  it("shows one day when the view is inside it", () => {
    timeline(day + 12 * HOUR);
    const days = labels().filter((l) => /^\w{3} \d{2}-\d{2}-\d{4}$/.test(l ?? ""));
    expect(days).toEqual(["Thu 29-10-2026"]);
    expect(labels().at(-1)).toBe("12:00:00");
  });
});
