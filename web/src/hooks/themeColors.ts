import { useMemo } from "react";
import { useTheme } from "./theme";

/** Resolves theme tokens to concrete colors for SVG attributes (which cannot read CSS variables). */
export function useThemeColors() {
  const { theme } = useTheme();
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const rgb = (name: string) => `rgb(${style.getPropertyValue(`--${name}`).trim().split(/\s+/).join(",")})`;
    return {
      accent: rgb("accent"),
      ink: rgb("ink"),
      inkSecondary: rgb("ink-secondary"),
      inkMuted: rgb("ink-muted"),
      line: rgb("line"),
      lineStrong: rgb("line-strong"),
      surface: rgb("surface"),
      warn: rgb("warn"),
      bad: rgb("bad"),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}
