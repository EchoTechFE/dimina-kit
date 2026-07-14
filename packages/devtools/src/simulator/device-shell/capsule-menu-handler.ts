import { uiOverlayBus, type CapsuleMenuDialogState } from '../ui-overlay-bus'

/**
 * Builds and shows the capsule "more" menu dialog. The dialog presents
 * app info and a "复制链接" action item (matching the HarmonyOS native
 * `DMPMiniProgramMenuDialog`).
 */
export function showCapsuleMenu(appId: string, title: string): void {
  const dialog: CapsuleMenuDialogState = {
    kind: 'capsuleMenu',
    appName: title || '小程序',
    appAvatar: '',
    appVersion: '1.0.0',
    items: [{ label: '复制链接', icon: '🔗' }],
    onSelect(index: number) {
      if (index === 0) {
        void navigator.clipboard.writeText(
          `https://qiandao.com/miniapp?appId=${appId}`,
        )
      }
      uiOverlayBus.hideDialog()
    },
  }
  uiOverlayBus.showDialog(dialog)
}
