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
        sans: ['"Manrope"', 'sans-serif'],
        display: ['"Manrope"', 'sans-serif'],
        brand: ['"Manrope"', 'sans-serif'],
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
        'mesh-soft': 'linear-gradient(180deg, #050b1a 0%, #050b1a 100%)',
        'mesh-soft-light':
          'radial-gradient(circle at 82% 4%, rgba(22, 119, 255, 0.08), transparent 26%), linear-gradient(180deg, #f4f7fc 0%, #eef3f9 45%, #e8eef6 100%)',
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
