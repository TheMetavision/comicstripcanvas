/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        charcoal: '#111111',
        'comic-red': '#EC008C',
        'comic-yellow': '#FFF200',
        'comic-cyan': '#00AEEF',
        'off-white': '#F5F5F5',
        'panel-dark': '#1A1A1A',
        'dark-grey': '#222222',
        'mid-grey': '#333333',
      },
      fontFamily: {
        bangers: ['Bangers', 'cursive'],
        russo: ['Russo One', 'sans-serif'],
        oswald: ['Oswald', 'sans-serif'],
        source: ['Source Sans 3', 'sans-serif'],
        comic: ['Comic Neue', 'cursive'],
      },
      boxShadow: {
        'comic-red': '0 0 20px rgba(236, 0, 140, 0.6)',
        'comic-yellow': '0 0 20px rgba(255, 242, 0, 0.6)',
        'comic-cyan': '0 0 20px rgba(0, 174, 239, 0.6)',
        'comic-border': '4px 4px 0 #000000',
      },
      clipPath: {
        diagonal: 'polygon(0 0, 100% 0, 100% 85%, 0 100%)',
      },
    },
  },
  plugins: [],
};
