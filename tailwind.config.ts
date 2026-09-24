import type { Config } from "tailwindcss";

// Design tokens live as CSS variables in app/globals.css; this maps them to Tailwind names.
// Phase 3 extends this with type scale, radii and component tokens.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        accent: "var(--accent)",
        credit: "var(--credit)",
        pending: "var(--pending)",
        debit: "var(--debit)",
        reversed: "var(--reversed)",
      },
    },
  },
  plugins: [],
};

export default config;
