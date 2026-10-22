import { badRequest } from "./errors.js";

/** CSV files people open in Excel: UTF-8 with BOM, CRLF lines, formula-safe cells. */

/** A CSV cell, quoted when needed; a leading = + - @ is neutralised so spreadsheets do not run it as a formula. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A CSV document from rows of cells, UTF-8 with BOM so Excel reads it. */
export function toCsv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a time zone; throws a 400 for a zone the runtime does not know. */
export function zonedParts(ms: number, timeZone: string) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      throw badRequest(`Unknown time zone "${timeZone}"`);
    }
    if (formatters.size > 50) formatters.clear();
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`, asUtcMs: Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) };
}

/** The instant a calendar day (YYYY-MM-DD) starts in a time zone, DST included. */
export function startOfDay(day: string, timeZone: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - (zonedParts(t, timeZone).asUtcMs - t);
  return new Date(t);
}

export const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
