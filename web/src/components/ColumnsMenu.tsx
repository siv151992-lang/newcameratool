import { Columns3 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui";

/** A "Columns" button that opens a checklist of the table's optional columns. */
export function ColumnsMenu({
  columns,
  isVisible,
  setVisible,
  showAll,
  hiddenCount,
}: {
  columns: { key: string; label: string }[];
  isVisible: (key: string) => boolean;
  setVisible: (key: string, visible: boolean) => void;
  showAll: () => void;
  hiddenCount: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        icon={<Columns3 className="h-4 w-4" />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        Columns{hiddenCount > 0 ? ` (${columns.length - hiddenCount}/${columns.length})` : ""}
      </Button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Choose visible columns"
          className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-2 shadow-lg"
        >
          <p className="px-2 pb-1 text-xs text-ink-muted">Camera and Actions are always shown.</p>
          <ul className="max-h-[70vh] overflow-y-auto">
            {columns.map((col) => (
              <li key={col.key}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-line/60">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[rgb(var(--accent))]"
                    checked={isVisible(col.key)}
                    onChange={(e) => setVisible(col.key, e.target.checked)}
                  />
                  {col.label}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-line pt-2">
            <Button size="sm" variant="ghost" className="w-full" disabled={hiddenCount === 0} onClick={showAll}>
              Show all columns
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
