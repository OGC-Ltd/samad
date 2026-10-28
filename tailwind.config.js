/** @type {import('tailwindcss').Config} */

// Tailwind is here to support the shadcn/ui chart components, NOT to restyle the
// app. Two deliberate constraints keep it from leaking:
//
//  1. `preflight: false` — Tailwind's global reset would otherwise rewrite
//     margins, padding, borders, list styles and heading font-sizes on every
//     element in the app. There are 51 hand-written stylesheets here that
//     assume the browser defaults; the reset would visually break all of them.
//     Everything Tailwind emits is therefore additive utility classes only.
//
//  2. The colour scale maps onto the app's OWN theme tokens (declared on
//     .app--dark / .app--light in App.scss) instead of shipping Tailwind's
//     palette. `bg-card` resolves to var(--color-card), so a shadcn component
//     follows the existing theme toggle for free — no `dark:` variants, no
//     second source of truth for colour, nothing to keep in sync.
//
// Because these are var() references rather than hex, the slash-opacity syntax
// (`bg-card/50`) will not work on them. Use explicit opacity utilities instead.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // App theme tokens, exposed under shadcn's semantic names.
        background:  'var(--color-bg)',
        foreground:  'var(--color-text-primary)',
        card:        'var(--color-card)',
        'card-inner': 'var(--color-card-inner)',
        border:      'var(--color-border)',
        muted:       'var(--color-card-inner)',
        'muted-foreground': 'var(--color-text-sec)',
        subtle:      'var(--color-text-muted)',
      },
      fontSize: {
        // The chart's own scale — smaller than Tailwind's defaults, matching
        // the axis/legend sizes the hand-rolled SVG charts already use.
        micro: ['10px', '14px'],
        tiny:  ['11px', '16px'],
      },
    },
  },
  plugins: [],
}
