import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useColumnVisibility } from "../hooks/columns";
import { ColumnsMenu } from "./ColumnsMenu";

const COLUMNS = [
  { key: "host", label: "IP address" },
  { key: "recording", label: "Recording" },
  { key: "usage", label: "Usage" },
];

function Harness() {
  const visibility = useColumnVisibility("test-columns", COLUMNS.map((c) => c.key));
  return (
    <>
      <ColumnsMenu columns={COLUMNS} {...visibility} />
      <p data-testid="visible">{COLUMNS.filter((c) => visibility.isVisible(c.key)).map((c) => c.key).join(",")}</p>
    </>
  );
}

const visible = () => screen.getByTestId("visible").textContent;

describe("ColumnsMenu", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("hides and shows columns, and remembers the choice", () => {
    const { unmount } = render(<Harness />);
    expect(visible()).toBe("host,recording,usage");
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    fireEvent.click(screen.getByLabelText("Recording"));
    expect(visible()).toBe("host,usage");
    expect(screen.getByRole("button", { name: "Columns (2/3)" })).toBeTruthy();
    expect(localStorage.getItem("test-columns")).toBe('["recording"]');

    unmount();
    render(<Harness />);
    expect(visible()).toBe("host,usage");
  });

  it("shows all columns again, and ignores stored keys that no longer exist", () => {
    localStorage.setItem("test-columns", '["usage","removedColumn"]');
    render(<Harness />);
    expect(visible()).toBe("host,recording");
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
    expect(visible()).toBe("host,recording,usage");
    expect(localStorage.getItem("test-columns")).toBeNull();
  });

  it("closes on Escape", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    expect(screen.getByRole("group", { name: "Choose visible columns" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Choose visible columns" })).toBeNull();
  });
});
