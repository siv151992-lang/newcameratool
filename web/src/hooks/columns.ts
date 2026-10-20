import { useCallback, useState } from "react";

/**
 * Which optional table columns are hidden, remembered per browser. Only hidden keys are stored,
 * so columns added in later versions show up by default. Storage failures (private windows,
 * blocked site data) fall back to showing every column.
 */
export function useColumnVisibility(storageKey: string, columnKeys: readonly string[]) {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return new Set(Array.isArray(stored) ? stored.filter((k): k is string => columnKeys.includes(k)) : []);
    } catch {
      return new Set();
    }
  });

  const save = useCallback(
    (next: Set<string>) => {
      setHidden(next);
      try {
        if (next.size === 0) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // Not persisted; the choice still applies until the page is reloaded.
      }
    },
    [storageKey],
  );

  return {
    isVisible: (key: string) => !hidden.has(key),
    setVisible: (key: string, visible: boolean) => {
      const next = new Set(hidden);
      if (visible) next.delete(key);
      else next.add(key);
      save(next);
    },
    showAll: () => save(new Set()),
    hiddenCount: hidden.size,
  };
}
