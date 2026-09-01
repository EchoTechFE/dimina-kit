/* Tailwind aliases for the CSS variables in src/css/tokens.css.
 *
 * Every value here must resolve to a variable that tokens.css actually
 * defines — an alias pointing at an undefined variable produces a class that
 * silently paints nothing. tailwind-preset.test.ts derives the variable list
 * from this file and checks it against tokens.css, so the two cannot drift.
 *
 * Usage in a host's tailwind.config.cjs:
 *   presets: [require('@dimina-kit/design/tailwind-preset')]
 * then add your own `content` and any host-owned extensions.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        accent: 'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        bg: 'var(--color-bg)',
        'bg-panel': 'var(--color-bg-panel)',
        surface: 'var(--color-surface)',
        'surface-2': 'var(--color-surface-2)',
        'surface-3': 'var(--color-surface-3)',
        'surface-active': 'var(--color-surface-active)',
        'surface-input': 'var(--color-surface-input)',
        'surface-selected': 'var(--color-surface-selected)',
        'surface-thumb': 'var(--color-surface-thumb)',
        'surface-splitter': 'var(--color-surface-splitter)',
        border: 'var(--color-border)',
        'border-subtle': 'var(--color-border-subtle)',
        'border-strong': 'var(--color-border-strong)',
        ring: 'var(--color-ring)',
        text: 'var(--color-text)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-muted': 'var(--color-text-muted)',
        'text-dim': 'var(--color-text-dim)',
        'code-blue': 'var(--color-code-blue)',
        'code-orange': 'var(--color-code-orange)',
        'code-label': 'var(--color-code-label)',
        'code-number': 'var(--color-code-number)',
        'code-keyword': 'var(--color-code-keyword)',
        'status-warn': 'var(--color-status-warn)',
        'status-error': 'var(--color-status-error)',
        'status-success': 'var(--color-status-success)',
        'danger-bg': 'var(--color-danger-bg)',
        'warn-bg': 'var(--color-warn-bg)',
        'warn-border': 'var(--color-warn-border)',
        overlay: 'var(--color-overlay)',
        'overlay-heavy': 'var(--color-overlay-heavy)',
      },
      fontFamily: {
        sans: ['var(--font-family)'],
        mono: ['var(--font-family-mono)'],
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
    },
  },
}
