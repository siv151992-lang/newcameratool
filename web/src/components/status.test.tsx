import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "../hooks/theme";
import { ConnectionBadge, HealthBadge, RecordingBadge, UsageMeter } from "./status";

describe("status indicators", () => {
  it("always carry a text label, not just a color", () => {
    render(
      <>
        <ConnectionBadge status="offline" />
        <ConnectionBadge status="online" monitoringEnabled={false} />
        <HealthBadge health="critical" />
        <HealthBadge health="unknown" />
      </>,
    );
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Monitoring off")).toBeTruthy();
    expect(screen.getByText("Critical")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("labels each recording state and shows what the camera reported on hover", () => {
    render(
      <>
        <RecordingBadge state="recording" detail="status: recording" />
        <RecordingBadge state="idle" />
        <RecordingBadge state="error" />
      </>,
    );
    expect(screen.getByText("Recording").closest("span")?.getAttribute("title")).toBe("status: recording");
    expect(screen.getByText("Not recording")).toBeTruthy();
    expect(screen.getByText("Recording error")).toBeTruthy();
  });

  it("shows usage as text and an accessible meter", () => {
    render(<UsageMeter percent={95.38} />);
    expect(screen.getByText("95.4%")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("95.38");
  });

  it("renders a dash when usage is unknown instead of inventing a value", () => {
    render(<UsageMeter percent={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

function Toggle() {
  const { theme, toggle, setPalette, setTheme } = useTheme();
  return (
    <>
      <button onClick={toggle}>{theme}</button>
      <button onClick={() => setPalette("zoho")}>zoho</button>
      <button onClick={() => setTheme("system")}>system</button>
    </>
  );
}

describe("theme", () => {
  it("toggles without reload and persists the choice", () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    localStorage.clear();
    render(<ThemeProvider><Toggle /></ThemeProvider>);
    const btn = screen.getAllByRole("button")[0]!;
    expect(btn.textContent).toBe("light");
    act(() => fireEvent.click(btn));
    expect(btn.textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("cctv-theme")).toBe("dark");
  });

  it("applies a color theme and can follow the operating system", () => {
    cleanup();
    const dark = true;
    window.matchMedia = ((q: string) => ({ matches: dark, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    localStorage.clear();
    render(<ThemeProvider><Toggle /></ThemeProvider>);
    act(() => fireEvent.click(screen.getByText("zoho")));
    expect(document.documentElement.dataset.palette).toBe("zoho");
    expect(localStorage.getItem("cctv-palette")).toBe("zoho");
    act(() => fireEvent.click(screen.getByText("system")));
    expect(document.documentElement.classList.contains("dark")).toBe(dark);
    expect(localStorage.getItem("cctv-theme")).toBe("system");
  });
});
