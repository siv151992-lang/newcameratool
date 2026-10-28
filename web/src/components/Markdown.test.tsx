import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { isAppPath, Markdown } from "./Markdown";

const show = (text: string) => render(<MemoryRouter><Markdown text={text} /></MemoryRouter>);

describe("Markdown", () => {
  afterEach(cleanup);

  it("renders lists, bold text, tables and internal links", () => {
    show("Two cameras:\n\n1. **Office 03** — [details](/cameras/abc)\n2. Entrance\n\n| Camera | Used |\n| --- | --- |\n| Lobby | 81% |");
    expect(screen.getByText("Office 03").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "details" }).getAttribute("href")).toBe("/cameras/abc");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "81%" })).toBeTruthy();
  });

  it("never renders HTML or links that leave the app", () => {
    const { container } = show('<img src=x onerror="alert(1)"> [evil](https://evil.example) [proto](//evil.example) [js](javascript:alert(1))');
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.textContent).toContain("<img src=x");
    expect(container.textContent).toContain("evil");
  });

  it("does not take a backslash path for one inside the app (browsers read /\\host as //host)", () => {
    show("[a](/\\evil.example) [b](/x\\y) [c](/cameras/ok)");
    expect(screen.queryAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/cameras/ok"]);
    expect(["/cameras/1", "/x\\y", "/\\evil", "//evil", "/\u0009/evil", "https://x", "cameras"].map(isAppPath)).toEqual([true, false, false, false, false, false, false]);
  });
});
