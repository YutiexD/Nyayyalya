/**
 * Tailwind configuration.
 *
 * Colours are declared as CSS variables in src/styles/globals.css and referenced
 * through `hsl(var(--token))` here, which is what lets one class list serve both
 * light and dark without a single `dark:` variant on a colour.
 *
 * The palette is deliberately restrained: one navy accent carried over from the
 * previous client, a neutral surface ramp, and semantic tokens for the three verdicts
 * this product renders (ok / warn / bad). An evidence register should look like a
 * government record, not a dashboard.
 */
import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // The three verdicts. Named for what they mean, not what colour they are, so
        // a component never has to decide what "green" implies.
        ok: { DEFAULT: 'hsl(var(--ok))', foreground: 'hsl(var(--ok-foreground))', muted: 'hsl(var(--ok-muted))' },
        warn: { DEFAULT: 'hsl(var(--warn))', foreground: 'hsl(var(--warn-foreground))', muted: 'hsl(var(--warn-muted))' },
        bad: { DEFAULT: 'hsl(var(--bad))', foreground: 'hsl(var(--bad-foreground))', muted: 'hsl(var(--bad-muted))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // A hash is read character by character off a projector; it gets its own size
        // and never inherits body leading.
        hash: ['0.8125rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
};
