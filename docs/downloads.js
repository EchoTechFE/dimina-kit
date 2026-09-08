const latestReleaseUrl = 'https://api.github.com/repos/EchoTechFE/dimina-kit/releases/latest'

async function updateDownloadLinks() {
  const status = document.querySelector('[data-release-status]')
  try {
    const response = await fetch(latestReleaseUrl)
    if (!response.ok) throw new Error(`GitHub Releases returned ${response.status}`)
    const release = await response.json()
    const assets = Array.isArray(release.assets) ? release.assets : []
    const links = [...document.querySelectorAll('[data-asset-suffix]')]
    const matchedAssets = links.map(link => assets.find(asset => typeof asset.name === 'string' && asset.name.endsWith(link.dataset.assetSuffix)))
    if (matchedAssets.some(asset => !asset || typeof asset.browser_download_url !== 'string')) throw new Error('Latest release is missing a desktop asset')

    for (const [index, link] of links.entries()) link.href = matchedAssets[index].browser_download_url

    const versionMatch = matchedAssets[0].name.match(/^dimina-devtools-(.+)-mac-arm64\.dmg$/)
    if (versionMatch) document.querySelector('[data-release-version]').textContent = `Dimina DevTools ${versionMatch[1]}`
  } catch {
    if (status) status.textContent = '暂时无法更新版本信息，已显示默认下载链接。'
  }
}

void updateDownloadLinks()
