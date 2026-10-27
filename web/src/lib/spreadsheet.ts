/**
 * Reads camera lists from spreadsheets in the browser: Excel workbooks (.xlsx) and tab-separated
 * text (.txt / .tsv, as Excel's "Unicode Text" and Bosch Project Assistant save it). Nothing is
 * uploaded: an .xlsx is a zip of XML parts, unzipped here with the browser's own decompression.
 */

export interface Sheet {
  name: string;
  rows: string[][];
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** The files in a zip archive, by name (read lazily). */
function zipEntries(bytes: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  // End of central directory: the last "PK\x05\x06" (within the 64 KiB comment allowance).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not an Excel (.xlsx) file.");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out = new Map<string, () => Promise<Uint8Array>>();
  for (let n = 0; n < count && u32(bytes, p) === 0x02014b50; n++) {
    const method = u16(bytes, p + 10);
    const size = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const local = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    out.set(name, async () => {
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) throw new Error("The workbook uses a compression this browser cannot read.");
      const source = new ReadableStream<BufferSource>({
        start(controller) {
          controller.enqueue(data.slice());
          controller.close();
        },
      });
      const stream = source.pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }
  return out;
}

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const byTag = (node: Document | Element, tag: string) => Array.from(node.getElementsByTagNameNS("*", tag));

/** Column index from a cell reference: "C7" → 2. */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Every worksheet of an .xlsx workbook, as rows of cell text (as shown, not formulas). */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = zipEntries(bytes);
  const read = async (name: string) => {
    const entry = zip.get(name);
    return entry ? new TextDecoder().decode(await entry()) : undefined;
  };
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("This is not an Excel (.xlsx) file.");
  const rels = xml((await read("xl/_rels/workbook.xml.rels")) ?? "<Relationships/>");
  const targets = new Map(byTag(rels, "Relationship").map((r) => [r.getAttribute("Id"), r.getAttribute("Target") ?? ""]));
  const sharedXml = await read("xl/sharedStrings.xml");
  const shared = sharedXml ? byTag(xml(sharedXml), "si").map((si) => byTag(si, "t").map((t) => t.textContent ?? "").join("")) : [];

  const sheets: Sheet[] = [];
  for (const s of byTag(xml(workbook), "sheet")) {
    const id = s.getAttribute("r:id") ?? s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = targets.get(id);
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const sheetXml = await read(path);
    if (!sheetXml) continue;
    const rows: string[][] = [];
    for (const row of byTag(xml(sheetXml), "row")) {
      const r = Number(row.getAttribute("r") ?? rows.length + 1) - 1;
      const cells: string[] = [];
      for (const c of byTag(row, "c")) {
        const type = c.getAttribute("t");
        const v = byTag(c, "v")[0]?.textContent ?? "";
        const text = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? byTag(c, "t").map((t) => t.textContent ?? "").join("") : v;
        cells[columnOf(c.getAttribute("r") ?? "A1")] = text;
      }
      rows[r] = Array.from(cells, (x) => x ?? "");
    }
    sheets.push({ name: s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`, rows: Array.from(rows, (x) => x ?? []) });
  }
  return sheets;
}

/** Tab-separated text: UTF-16 with a byte-order mark (Excel's "Unicode Text"), else UTF-8. */
export function readTabText(bytes: Uint8Array): string[][] {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, "");
  return text.split(/\r?\n/).map((line) => line.split("\t").map((c) => c.replace(/^"(.*)"$/s, "$1").replace(/""/g, '"')));
}

/** The app's import columns. */
export const IMPORT_COLUMNS = ["name", "ip", "brand", "model", "username", "password", "location", "port", "protocol"] as const;
export type ImportRecord = Record<(typeof IMPORT_COLUMNS)[number], string>;

/**
 * Bosch Project Assistant lists name their columns with tags in brackets ("IP address [ip]",
 * "Commercial type number [ctn]", "[password:service]"). Their cameras are Bosch, and the
 * "service" account is the camera's administrator.
 */
function boschTag(header: string): string | undefined {
  return /\[([a-z:]+)\]/i.exec(header)?.[1]?.toLowerCase();
}

/**
 * Turns a sheet (header row first) into import rows: the app's own columns, or a Bosch Project
 * Assistant list. Returns null when the header has neither.
 */
export function toImportRecords(rows: string[][]): { records: ImportRecord[]; format: "app" | "bosch" } | null {
  const headerIndex = rows.findIndex((r) => r.some((c) => c.trim()));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex]!.map((h) => h.trim());
  const body = rows.slice(headerIndex + 1).filter((r) => r.some((c) => c?.trim()));
  const tags = header.map(boschTag);
  if (tags.includes("ip") && (tags.includes("name") || tags.includes("ctn"))) {
    const at = (r: string[], tag: string) => (r[tags.indexOf(tag)] ?? "").trim();
    return {
      format: "bosch",
      records: body.map((r) => {
        const password = at(r, "password:service");
        return {
          name: at(r, "name") || at(r, "ctn") || at(r, "ip"),
          ip: at(r, "ip"),
          brand: "Bosch",
          model: at(r, "ctn") || at(r, "productname"),
          username: password ? "service" : "",
          password,
          location: at(r, "info"),
          port: "",
          protocol: "",
        };
      }),
    };
  }
  const lower = header.map((h) => h.toLowerCase());
  if (!lower.includes("name") || !lower.includes("ip")) return null;
  return {
    format: "app",
    records: body.map((r) => Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, (r[lower.indexOf(c)] ?? "").trim()])) as ImportRecord),
  };
}
