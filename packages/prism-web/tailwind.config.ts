import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        panel: "var(--color-panel)",
        surface: "var(--color-surface)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        // Hex variables cannot take an opacity modifier on their own; mixing
        // with transparent lets `bg-mint/10` and friends generate.
        mint: "color-mix(in srgb, var(--color-mint) calc(<alpha-value> * 100%), transparent)",
        primary: {
          DEFAULT: "var(--color-primary)",
          foreground: "var(--color-on-primary)",
        },
        coral: "color-mix(in srgb, var(--color-coral) calc(<alpha-value> * 100%), transparent)",
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
      },
    },
  },
  plugins: [],
} satisfies Config;
