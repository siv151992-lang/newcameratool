import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Renders the small Markdown subset the assistant and reports use: headings, paragraphs,
 * bullet and numbered lists, pipe tables, **bold**, _italic_, `code` and links. It builds React
 * elements (never HTML strings), and only links to paths inside this app ("/cameras/…"); any
 * other link target is shown as plain text.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w])_[^_]+_(?![\w]))/g;

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k} className="font-semibold text-ink">{inline(part.slice(2, -2), k)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={k} className="rounded bg-page px-1 text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) return <em key={k}>{inline(part.slice(1, -1), k)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      return href!.startsWith("/") && !href!.startsWith("//") ? (
        <Link key={k} to={href!} className="font-medium text-accent-ink hover:underline">{label}</Link>
      ) : (
        <Fragment key={k}>{label}</Fragment>
      );
    }
    return <Fragment key={k}>{part}</Fragment>;
  });
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const cls = level === 1 ? "text-lg font-semibold" : level === 2 ? "mt-2 text-base font-semibold" : "font-semibold";
      blocks.push(<p key={key} className={`${cls} text-ink`}>{inline(heading[2]!, key)}</p>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-secondary">
              <tr>{head.map((h, j) => <th key={j} scope="col" className="px-2 py-1.5 font-medium">{inline(h, `${key}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-line last:border-0">
                  {r.map((c, ci) => <td key={ci} className="px-2 py-1.5">{inline(c, `${key}r${ri}c${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i]!)) items.push(lines[i++]!.replace(pattern, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
          {items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4})\s/.test(lines[i]!) && !bullet.test(lines[i]!) && !numbered.test(lines[i]!) && !/^\s*\|/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={className ?? "space-y-2 text-sm leading-relaxed text-ink"}>{blocks}</div>;
}
