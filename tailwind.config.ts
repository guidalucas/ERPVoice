import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      boxShadow: {
        glow: '0 24px 80px rgba(2, 6, 23, 0.38)',
      },
      fontFamily: {
        sans: ['"Outfit"', 'sans-serif'],
        display: ['"Outfit"', 'sans-serif'],
        brand: ['"Outfit"', 'sans-serif'],
      },
      fontWeight: {
        brand: '800',
        title: '700',
        subtitle: '600',
        body: '400',
        'body-strong': '500',
        metric: '700',
        'metric-strong': '800',
      },
      backgroundImage: {
        'mesh-soft': 'var(--background)',
        'mesh-soft-light': 'var(--background)',
        'brand-gradient': 'var(--brand-gradient)',
      },
      colors: {
        surface: 'var(--surface)',
        elevated: 'var(--surface-elevated)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        canvas: 'var(--background)',
        ink: 'var(--text)',
        line: 'var(--border)',
      },
    },
  },
  plugins: [],
} satisfies Config;
