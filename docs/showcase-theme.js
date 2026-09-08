const preferenceKey = 'dimina-showcase-theme'
const darkMedia = '(prefers-color-scheme: dark)'
const productShot = document.querySelector('[data-product-shot]')
const darkSource = productShot?.querySelector('source')
const themeButtons = [...document.querySelectorAll('[data-shot-theme]')]

function applyShowcaseTheme(theme) {
  if (!darkSource || !['system', 'light', 'dark'].includes(theme)) return

  darkSource.media = theme === 'system' ? darkMedia : theme === 'dark' ? 'all' : 'not all'
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.shotTheme === theme))
  }
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const theme = button.dataset.shotTheme
    applyShowcaseTheme(theme)
    try {
      localStorage.setItem(preferenceKey, theme)
    } catch {}
  })
}

let savedTheme = 'system'
try {
  savedTheme = localStorage.getItem(preferenceKey) || savedTheme
} catch {}
applyShowcaseTheme(savedTheme)
