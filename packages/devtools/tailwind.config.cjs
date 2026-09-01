const path = require('node:path')

/* @dimina-kit/inspect ships React panels that use this app's token aliases
 * (bg-surface-2, text-code-keyword, …) and no stylesheet of its own — the host
 * that renders them is what generates their classes. Resolve it through node
 * rather than a relative path so this line keeps working from a published
 * install, not just from inside the monorepo. */
const inspectDir = path.dirname(require.resolve('@dimina-kit/inspect/package.json'))

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@dimina-kit/design/tailwind-preset')],
  content: [
    './src/renderer/**/*.{html,js,jsx,ts,tsx}',
    path.join(inspectDir, 'src/**/*.tsx'),
  ],
  theme: {
    extend: {
      colors: {
        /* Simulator hardware chrome — devtools-owned, defined in design.css. */
        'sim-bg': 'var(--color-sim-bg)',
        'sim-bottom': 'var(--color-sim-bottom)',
        'sim-screen': 'var(--color-sim-screen)',
        'phone-shell': 'var(--color-phone-shell)',
        'phone-border': 'var(--color-phone-border)',
      },
    },
  },
  plugins: [],
}
