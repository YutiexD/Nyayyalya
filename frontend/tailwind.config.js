/**
 * Tailwind configuration — Starbucks-inspired green design system.
 *
 * Colours are declared as CSS variables in src/styles/globals.css and referenced
 * through `hsl(var(--token))` here, which is what lets one class list serve both
 * light and dark without a single `dark:` variant on a colour.
 *
 * The palette uses a four-tier Starbucks green system: Starbucks Green (#006241),
 * Green Accent (#00754A), House Green (#1E3932), and warm cream (#f2f0eb). Semantic
 * tokens for the three verdicts (ok / warn / bad) are unchanged.
 */
import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: '1rem', sm: '1.5rem', lg: '2rem' },
      // Application content never runs wider than this. Long lines of case metadata are
      // harder to scan, not easier.
      screens: { '2xl': '1280px' },
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
        // Starbucks brand colours — fixed hex values for direct use.
        'starbucks-green': '#006241',
        'green-accent': '#00754A',
        'house-green': '#1E3932',
        'gold': '#cba258',
        'neutral-warm': '#f2f0eb',
        'ceramic': '#edebe9',
        // The three verdicts. Named for what they mean, not what colour they are, so
        // a component never has to decide what "green" implies.
        // The accent gradient's two ends, usable as plain colours too (icons, rings).
        'accent-from': 'hsl(var(--accent-from))',
        'accent-to': 'hsl(var(--accent-to))',
        // `success` / `warning` / `danger` are aliases of ok / warn / bad, for authors who
        // think in those words. Same variables, so the two can never drift apart.
        success: { DEFAULT: 'hsl(var(--ok))', foreground: 'hsl(var(--ok-foreground))', muted: 'hsl(var(--ok-muted))' },
        warning: { DEFAULT: 'hsl(var(--warn))', foreground: 'hsl(var(--warn-foreground))', muted: 'hsl(var(--warn-muted))' },
        danger: { DEFAULT: 'hsl(var(--bad))', foreground: 'hsl(var(--bad-foreground))', muted: 'hsl(var(--bad-muted))' },
        ok: { DEFAULT: 'hsl(var(--ok))', foreground: 'hsl(var(--ok-foreground))', muted: 'hsl(var(--ok-muted))' },
        warn: { DEFAULT: 'hsl(var(--warn))', foreground: 'hsl(var(--warn-foreground))', muted: 'hsl(var(--warn-muted))' },
        bad: { DEFAULT: 'hsl(var(--bad))', foreground: 'hsl(var(--bad-foreground))', muted: 'hsl(var(--bad-muted))' },
        info: { DEFAULT: 'hsl(var(--info))', foreground: 'hsl(var(--info-foreground))', muted: 'hsl(var(--info-muted))' },
        // Review priority. One ramp, four stops, in order of urgency — see globals.css.
        priority: {
          critical: 'hsl(var(--p-critical))',
          'critical-muted': 'hsl(var(--p-critical-muted))',
          high: 'hsl(var(--p-high))',
          'high-muted': 'hsl(var(--p-high-muted))',
          medium: 'hsl(var(--p-medium))',
          'medium-muted': 'hsl(var(--p-medium-muted))',
          low: 'hsl(var(--p-low))',
          'low-muted': 'hsl(var(--p-low-muted))',
        },
      },
      borderRadius: {
        lg: '0.75rem',
        md: 'calc(0.75rem - 2px)',
        sm: 'calc(0.75rem - 4px)',
        pill: '50px',
        full: '9999px',
      },
      fontFamily: {
        sans: ['Inter', 'Manrope', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // The application type scale. Use these rather than arbitrary pixel sizes:
        //   text-title    page title            24px semibold
        //   text-section  panel / section title 16px semibold
        //   text-body     reading text          15px
        //   text-meta     secondary lines       13px
        //   text-label    field labels, eyebrows 12px
        title: ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.015em', fontWeight: '600' }],
        section: ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.005em', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.5rem' }],
        meta: ['0.8125rem', { lineHeight: '1.25rem' }],
        label: ['0.75rem', { lineHeight: '1rem' }],
        // A hash is read character by character off a projector; it gets its own size
        // and never inherits body leading.
        hash: ['0.8125rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        // Display sizes for the landing hero. Tight leading and tracking so a two-line
        // headline reads as one shape rather than two rows of text.
        'display-sm': ['2.75rem', { lineHeight: '1.05', letterSpacing: '-0.03em', fontWeight: '600' }],
        display: ['3.75rem', { lineHeight: '1.02', letterSpacing: '-0.035em', fontWeight: '600' }],
        'display-lg': ['4.75rem', { lineHeight: '1', letterSpacing: '-0.04em', fontWeight: '600' }],
      },
      boxShadow: {
        'elev-1': 'var(--shadow-1)',
        'elev-2': 'var(--shadow-2)',
        'elev-3': 'var(--shadow-3)',
        glow: 'var(--glow)',
      },
      backgroundImage: {
        // Kept for compatibility. Both ends now resolve to the same restrained accent, so
        // anything still using these renders as a flat tint rather than a gradient.
        'accent-gradient': 'linear-gradient(hsl(var(--primary)), hsl(var(--primary)))',
        'accent-gradient-soft': 'linear-gradient(hsl(var(--primary) / 0.08), hsl(var(--primary) / 0.08))',
      },
      transitionTimingFunction: {
        // One easing for every hover and reveal, so nothing feels "off" beside its neighbour.
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        // Magic UI. The CLI emits these as Tailwind v4 `@theme` blocks, which v3
        // ignores; declaring them here is what makes `animate-shimmer-slide` etc. exist.
        'shimmer-slide': { to: { transform: 'translate(calc(100cqw - 100%), 0)' } },
        'spin-around': {
          '0%': { transform: 'translateZ(0) rotate(0)' },
          '15%, 35%': { transform: 'translateZ(0) rotate(90deg)' },
          '65%, 85%': { transform: 'translateZ(0) rotate(270deg)' },
          '100%': { transform: 'translateZ(0) rotate(360deg)' },
        },
        gradient: { to: { backgroundPosition: 'var(--bg-size, 300%) 0' } },
        shine: {
          '0%': { backgroundPosition: '0% 0%' },
          '50%': { backgroundPosition: '100% 100%' },
          to: { backgroundPosition: '0% 0%' },
        },
        'shiny-text': {
          '0%, 90%, 100%': { backgroundPosition: 'calc(-100% - var(--shiny-width)) 0' },
          '30%, 60%': { backgroundPosition: 'calc(100% + var(--shiny-width)) 0' },
        },
        aurora: {
          '0%': { backgroundPosition: '0% 50%', transform: 'rotate(-5deg) scale(0.9)' },
          '25%': { backgroundPosition: '50% 100%', transform: 'rotate(5deg) scale(1.1)' },
          '50%': { backgroundPosition: '100% 50%', transform: 'rotate(-3deg) scale(0.95)' },
          '75%': { backgroundPosition: '50% 0%', transform: 'rotate(3deg) scale(1.05)' },
          '100%': { backgroundPosition: '0% 50%', transform: 'rotate(-5deg) scale(0.9)' },
        },
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
        'shimmer-slide': 'shimmer-slide var(--speed) ease-in-out infinite alternate',
        'spin-around': 'spin-around calc(var(--speed) * 2) infinite linear',
        gradient: 'gradient 8s linear infinite',
        shine: 'shine var(--duration) infinite linear',
        'shiny-text': 'shiny-text 8s infinite',
        aurora: 'aurora 8s ease-in-out infinite alternate',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
};
