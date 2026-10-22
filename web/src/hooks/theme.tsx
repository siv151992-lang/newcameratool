import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
/** What the user picked: a fixed mode, or follow the operating system. */
export type ThemeMode = Theme | "system";

/** Color themes: the accent used for buttons, links, highlights and charts. */
export const PALETTES = [
  { key: "blue", label: "Classic blue", swatch: "#2a78d6" },
  { key: "zoho", label: "Zoho", swatch: "#226DB4", brand: true },
  { key: "emerald", label: "Emerald", swatch: "#0f8a4a" },
  { key: "teal", label: "Teal", swatch: "#0e7c86" },
  { key: "violet", label: "Violet", swatch: "#6d4fd8" },
  { key: "rose", label: "Rose", swatch: "#c0305a" },
  { key: "sunset", label: "Sunset", swatch: "#c2530f" },
  { key: "graphite", label: "Graphite", swatch: "#3f4652" },
] as const;
export type Palette = (typeof PALETTES)[number]["key"];

const MODE_KEY = "cctv-theme";
const PALETTE_KEY = "cctv-palette";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore: the choice lasts for this page only */
  }
}

const osTheme = (): Theme => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const initialMode = (): ThemeMode => {
  const m = read(MODE_KEY);
  return m === "light" || m === "dark" || m === "system" ? m : "system";
};
const initialPalette = (): Palette => {
  const p = read(PALETTE_KEY);
  return PALETTES.some((x) => x.key === p) ? (p as Palette) : "blue";
};

interface ThemeState {
  /** The theme in effect. */
  theme: Theme;
  mode: ThemeMode;
  palette: Palette;
  toggle: () => void;
  setTheme: (t: ThemeMode) => void;
  setPalette: (p: Palette) => void;
}

const ThemeContext = createContext<ThemeState>({
  theme: "light",
  mode: "system",
  palette: "blue",
  toggle: () => undefined,
  setTheme: () => undefined,
  setPalette: () => undefined,
});

/**
 * Light or dark (or following the OS) and a color theme, saved in this browser. Switching is
 * instant (no reload); public/theme-init.js applies the saved choice before the first paint.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [os, setOs] = useState<Theme>(osTheme);
  const [palette, setPaletteState] = useState<Palette>(initialPalette);
  const theme = mode === "system" ? os : mode;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (palette === "blue") delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = palette;
  }, [palette]);

  // Follow OS changes while the mode is "system".
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setOs(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((m: ThemeMode) => {
    setMode(m);
    write(MODE_KEY, m);
  }, []);
  const setPalette = useCallback((p: Palette) => {
    setPaletteState(p);
    write(PALETTE_KEY, p);
  }, []);
  const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);

  return <ThemeContext.Provider value={{ theme, mode, palette, toggle, setTheme, setPalette }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
