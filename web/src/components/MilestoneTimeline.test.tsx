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

const playheadAt = () => Number.parseFloat(((screen.getByRole("slider").lastElementChild as HTMLElement).style.left));
const labels = () => [...screen.getByRole("slider").querySelectorAll("span")].map((s) => s.textContent);
const timeline = (time: number, withDay = true) =>
  render(<MilestoneTimeline time={time} span={HOUR} min={day - DAY} max={day + DAY} segments={[]} onSeek={() => {}} onScrub={() => {}} day={withDay ? day : undefined} />);

describe("timeline kept inside the day", () => {
  it("starts the view at 00:00 with the playhead at the left edge, not in the day before", () => {
    timeline(day);
    expect(playheadAt()).toBeLessThanOrEqual(1);
    // The date band names only this day; the scale starts at its first minute.
    expect(labels()[0]).toBe("Thu 29-10-2026");
    expect(labels()).not.toContain("Wed 28-10-2026");
    expect(labels()).not.toContain("23:50");
    // The playhead shows its time.
    expect(labels().at(-1)).toBe("00:00:00");
  });

  it("keeps the playhead in the middle during the day, and at the right edge at its end", () => {
    timeline(day + 12 * HOUR);
    expect(playheadAt()).toBe(400);
    cleanup();
    timeline(day + DAY - 15 * 60_000);
    expect(playheadAt()).toBe(600);
  });

  it("without a day, stays centred (the day before shows)", () => {
    timeline(day, false);
    expect(playheadAt()).toBe(400);
    expect(labels()).toEqual(expect.arrayContaining(["Wed 28-10-2026", "Thu 29-10-2026"]));
  });
});
