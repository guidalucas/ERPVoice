import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 20px 60px rgba(15, 23, 42, 0.14)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
      },
      backgroundImage: {
        'mesh-soft':
          'radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.16), transparent 28%), radial-gradient(circle at 80% 0%, rgba(16, 185, 129, 0.16), transparent 24%), linear-gradient(135deg, rgba(248, 250, 252, 1) 0%, rgba(226, 232, 240, 1) 100%)',
      },
    },
  },
  plugins: [],
} satisfies Config;