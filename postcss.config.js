// Tailwind 4 runs as its own PostCSS plugin and adds vendor prefixes itself,
// so autoprefixer is no longer needed here.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
