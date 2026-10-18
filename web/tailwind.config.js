/** Colors are CSS variables (see src/index.css) so light and dark themes swap in one place. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        page: v("page"),
        surface: v("surface"),
        raised: v("raised"),
        ink: { DEFAULT: v("ink"), secondary: v("ink-secondary"), muted: v("ink-muted") },
        line: { DEFAULT: v("line"), strong: v("line-strong") },
        accent: { DEFAULT: v("accent"), ink: v("accent-ink"), soft: v("accent-soft") },
        good: v("good"),
        warn: v("warn"),
        serious: v("serious"),
        bad: v("bad"),
        unknown: v("unknown"),
      },
      fontFamily: { sans: ["system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"] },
    },
  },
  plugins: [],
};
