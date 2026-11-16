import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Button } from "./ui";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Shown in red, apart from the others (Delete, Remove). */
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

/**
 * A compact "More actions" button that opens a list of actions: keeps rows and page headers to
 * the main action or two. Closes on a click outside, Escape or after choosing.
 */
export function ActionMenu({ label = "More actions", actions, buttonLabel, size = "md" }: { label?: string; actions: MenuAction[]; buttonLabel?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const visible = actions.filter((a) => !a.hidden);

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
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!visible.length) return null;
  const normal = visible.filter((a) => !a.danger);
  const danger = visible.filter((a) => a.danger);
  const item = (a: MenuAction) => (
    <button
      key={a.label}
      type="button"
      role="menuitem"
      disabled={a.disabled}
      onClick={() => {
        setOpen(false);
        a.onClick();
      }}
      className={clsx(
        "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-line/60 focus:bg-line/60 focus:outline-none disabled:opacity-50",
        a.danger ? "text-bad" : "text-ink",
      )}
    >
      {a.icon}
      {a.label}
    </button>
  );
  return (
    <div ref={ref} className="relative inline-block text-left">
      <Button
        size={size}
        variant={buttonLabel ? "secondary" : "ghost"}
        icon={<MoreHorizontal className="h-4 w-4" />}
        aria-label={buttonLabel ? undefined : label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        {buttonLabel}
      </Button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className="absolute right-0 z-30 mt-1 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {normal.map(item)}
          {danger.length > 0 && normal.length > 0 && <div className="my-1 border-t border-line" />}
          {danger.map(item)}
        </div>
      )}
    </div>
  );
}
