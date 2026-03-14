/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0a0a0f',
          1: '#12121a',
          2: '#1a1a25',
          3: '#222230',
        },
        accent: {
          blue: '#60a5fa',
          purple: '#a78bfa',
          green: '#34d399',
          amber: '#fbbf24',
          red: '#f87171',
          cyan: '#22d3ee',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
