import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 24px 80px rgba(2, 6, 23, 0.38)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
      },
      backgroundImage: {
        'mesh-soft':
          'radial-gradient(circle at 15% 10%, rgba(25, 195, 125, 0.16), transparent 24%), radial-gradient(circle at 82% 4%, rgba(59, 130, 246, 0.14), transparent 22%), radial-gradient(circle at 50% 100%, rgba(148, 163, 184, 0.08), transparent 28%), linear-gradient(180deg, rgba(5, 11, 22, 1) 0%, rgba(7, 17, 31, 1) 45%, rgba(11, 18, 32, 1) 100%)',
      },
    },
  },
  plugins: [],
} satisfies Config;