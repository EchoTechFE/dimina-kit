/**
 * UX behaviors of the menu+form compile-mode popover that only a real
 * Electron instance can prove: hover-tooltip presence/absence, form seeding
 * from the live simulator route, on-disk persistence merging onto an
 * existing project.config.json, real recompile+relaunch on selection,
 * fallback-on-delete, and the 逐条/原始串 round-trip contract.
 *
 * Every assertion targets a user-visible outcome (rendered page text, the
 * toolbar's own label, the on-disk config file) — never DOM class names or
 * source text as a stand-in for behavior.
 */
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  pollUntil,
  evalInWebContentsByUrl,
  evalInPopover,
  RENDER_GUEST_URL_MARKER,
  findPopoverWebContentsId,
  openCompileModePopover,
  closeCompileModePopover,
  compileModeToolbarButton,
  clickCompileModeMenuRow,
  clickCompileModeMenuEdit,
  clickCompileModeMenuAction,
  fillCompileModeForm,
  readCompileModeFormPathName,
  submitCompileModeForm,
  cancelCompileModeForm,
  deleteCompileModeForm,
  setCompileModeParamView,
  readCompileModeQueryRaw,
  setCompileModeQueryRaw,
  editCompileModeParamRow,
  readCompileModeToolbarLabel,
  readCompileModeMenuLabels,
} from './helpers'

const PROJECT_CONFIG_PATH = path.join(DEMO_APP_DIR, 'project.config.json')
let originalProjectConfig = ''
/**
 * The window this spec's project opens into. The toolbar, the compile-mode
 * button and the popover all live here — the project-list window (`mainWindow`)
 * has none of them — and `openProjectInUI` returns it, which is more precise
 * than the `workbench` fixture: that one resolves by listing order when no
 * shared project is registered, and another spec's window may still be open.
 */
let workbench: Page

/**
 * Read a specific render-host page guest's rendered text by its decoded
 * `pagePath` — `evalInWebContentsByUrl` takes the FIRST webContents matching
 * a URL substring, which is ambiguous once more than one page guest exists
 * at once, so tests that care WHICH page rendered filter on the encoded path
 * too instead.
 */
async function readRenderGuestText(electronApp: ElectronApplication, pagePath: string): Promise<string> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find((wc) => {
      const url = wc.getURL()
      return url.includes(payload.marker) && url.includes(payload.encodedPath)
    })
    if (!target || target.isLoading()) return ''
    return target.executeJavaScript('document.body.innerText').catch(() => '')
  }, { marker: RENDER_GUEST_URL_MARKER, encodedPath: encodeURIComponent(pagePath) })
}

/** Bounds of the dedicated tooltip WebContentsView, or null when none is mounted. */
function tooltipBounds(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('entries/workbench'),
    )
    if (!win) return null
    for (const child of win.contentView.children) {
      const view = child as unknown as {
        webContents?: { getURL(): string }
        getBounds(): { x: number; y: number; width: number; height: number }
      }
      if (view.webContents?.getURL().includes('entries/tooltip')) return view.getBounds()
    }
    return null
  })
}

test.describe('compile-mode popover UX', () => {
  test.setTimeout(120_000)

  // The popover persists to project.config.json on every apply, and
  // DEMO_APP_DIR is only recreated once per worker (not per test) — without
  // this, a mode created by an earlier test in this file would leak into the
  // next test's starting state (wrong toolbar label, extra menu rows).
  test.beforeEach(async ({ electronApp }) => {
    originalProjectConfig = fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8')
    workbench = await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 10000 })
  })

  test.afterEach(async ({ electronApp }) => {
    await closeProject(electronApp).catch(() => {})
    fs.writeFileSync(PROJECT_CONFIG_PATH, originalProjectConfig)
  })

  test('toolbar compile-mode button has no hover tooltip; 重新编译 does', async ({ electronApp }) => {
    await compileModeToolbarButton(workbench).hover()
    // SHOW_DELAY_MS (use-overlay-tooltip.ts) is 400ms; pollUntil's un-guarded
    // final read on timeout is exactly "sample once that window has passed"
    // — the correct way to assert something never shows up rather than
    // racing a fixed sleep against it.
    const afterHover = await pollUntil(
      () => tooltipBounds(electronApp),
      (bounds) => bounds !== null,
      900,
      100,
    )
    expect(afterHover, '编译模式按钮已经用自己的文字显示了选中的模式，不应该再弹悬浮提示').toBeNull()
    await workbench.mouse.move(1, 1)

    await workbench.getByRole('button', { name: '重新编译' }).hover()
    const relaunchTooltipText = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/tooltip', 'document.body.innerText'),
      (text) => text.trim() === '重新编译',
      10_000,
    )
    expect(relaunchTooltipText.trim()).toBe('重新编译')
    await workbench.mouse.move(1, 1)
  })

  test('以当前页面新建 seeds the form from the simulator route; confirming updates the menu and toolbar', async ({ electronApp }) => {
    // Move off the entry page first, so the seeded value can only have come
    // from the live route rather than incidentally matching the app's own
    // entry page.
    await openCompileModePopover(workbench, electronApp)
    await clickCompileModeMenuAction(electronApp, '添加编译模式')
    await fillCompileModeForm(electronApp, { pathName: 'pages/storage-test/storage-test' })
    await submitCompileModeForm(electronApp)

    await pollUntil(
      () => readRenderGuestText(electronApp, 'pages/storage-test/storage-test'),
      (text) => text.includes('Storage 存储测试'),
      25_000,
      400,
    )

    // The toolbar button now shows the just-created mode's own name, not
    // 普通编译, so it can't be reopened by a fixed label pattern.
    await compileModeToolbarButton(workbench).click()
    await findPopoverWebContentsId(electronApp)

    // `currentRoute` only updates once the relaunch's route report reaches
    // the toolbar controller; poll the real enable-state of the action row
    // instead of assuming it is already true right after the guest renders.
    await pollUntil(
      () => evalInPopover<boolean>(electronApp, `(() => {
        const target = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').trim() === '以当前页面新建')
        return !!target && !target.disabled
      })()`),
      (enabled) => enabled === true,
      10_000,
      300,
    )

    await clickCompileModeMenuAction(electronApp, '以当前页面新建')
    const seededPath = await readCompileModeFormPathName(electronApp)
    expect(seededPath, '"以当前页面新建" 必须用模拟器当前路由填充 启动页面').toBe('pages/storage-test/storage-test')

    await fillCompileModeForm(electronApp, { name: '存储测试模式' })
    await submitCompileModeForm(electronApp)

    const toolbarLabel = await pollUntil(
      () => readCompileModeToolbarLabel(workbench),
      (label) => label.includes('存储测试模式'),
      10_000,
      200,
    )
    expect(toolbarLabel, '工具栏必须切换成新建模式自己的名字').toContain('存储测试模式')

    await compileModeToolbarButton(workbench).click()
    await findPopoverWebContentsId(electronApp)
    const menuLabels = await readCompileModeMenuLabels(electronApp)
    expect(menuLabels, '新模式必须出现在菜单列表里').toContain('存储测试模式')
    await closeCompileModePopover(workbench)
  })

  test('a new mode persists into project.config.json under condition.miniprogram without clobbering unrelated fields', async ({ electronApp }) => {
    // Inject a field the save path has no business knowing about — proves
    // saveCompileModes MERGES onto the existing file instead of overwriting
    // it, which a "does condition.miniprogram round-trip" check alone can't.
    const before = JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8'))
    before.__e2eCanary = 'compile-mode-ux-canary'
    fs.writeFileSync(PROJECT_CONFIG_PATH, JSON.stringify(before, null, 2))

    await openCompileModePopover(workbench, electronApp)
    await clickCompileModeMenuAction(electronApp, '添加编译模式')
    await fillCompileModeForm(electronApp, { name: '持久化测试模式', pathName: 'pages/storage-test/storage-test' })
    await submitCompileModeForm(electronApp)

    await pollUntil(
      () => fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8'),
      (text) => text.includes('持久化测试模式'),
      10_000,
      200,
    )

    const after = JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8'))
    expect(after.__e2eCanary, 'saveCompileModes 必须合并进已有文件，不能整体重写掉不相关字段').toBe('compile-mode-ux-canary')
    const list = after.condition?.miniprogram?.list ?? []
    expect(
      list.some((m: { name?: string }) => m.name === '持久化测试模式'),
      '新模式必须写入 condition.miniprogram.list',
    ).toBe(true)
  })

  test('selecting a mode relaunches at its page for real; 普通编译 returns to the entry page', async ({ electronApp }) => {
    await openCompileModePopover(workbench, electronApp)
    await clickCompileModeMenuAction(electronApp, '添加编译模式')
    await fillCompileModeForm(electronApp, { name: '控制台模式', pathName: 'pages/console-test/console-test' })
    await submitCompileModeForm(electronApp)

    const onCustomPage = await pollUntil(
      () => readRenderGuestText(electronApp, 'pages/console-test/console-test'),
      (text) => text.includes('Console 输出测试'),
      25_000,
      400,
    )
    expect(onCustomPage).toContain('Console 输出测试')

    await compileModeToolbarButton(workbench).click()
    await findPopoverWebContentsId(electronApp)
    await clickCompileModeMenuRow(electronApp, '普通编译')

    const backOnEntry = await pollUntil(
      () => readRenderGuestText(electronApp, 'pages/index/index'),
      (text) => text.includes('DevTools 功能测试'),
      25_000,
      400,
    )
    expect(backOnEntry).toContain('DevTools 功能测试')
    expect(await readCompileModeToolbarLabel(workbench)).toContain('普通编译')
  })

  test('deleting the selected mode falls back to 普通编译 and the toolbar reverts', async ({ electronApp }) => {
    await openCompileModePopover(workbench, electronApp)
    await clickCompileModeMenuAction(electronApp, '添加编译模式')
    await fillCompileModeForm(electronApp, { name: '待删除模式', pathName: 'pages/storage-test/storage-test' })
    await submitCompileModeForm(electronApp)

    await pollUntil(
      () => readCompileModeToolbarLabel(workbench),
      (label) => label.includes('待删除模式'),
      10_000,
      200,
    )

    await compileModeToolbarButton(workbench).click()
    await findPopoverWebContentsId(electronApp)
    await clickCompileModeMenuEdit(electronApp, '待删除模式')
    await deleteCompileModeForm(electronApp)

    const toolbarLabel = await pollUntil(
      () => readCompileModeToolbarLabel(workbench),
      (label) => label.includes('普通编译'),
      10_000,
      200,
    )
    expect(toolbarLabel, '删除当前选中的模式必须回落到普通编译').toContain('普通编译')
  })

  test('原始串 survives a look at 逐条 unchanged; an actual row edit regenerates it', async ({ electronApp }) => {
    await openCompileModePopover(workbench, electronApp)
    await clickCompileModeMenuAction(electronApp, '添加编译模式')

    await setCompileModeParamView(electronApp, '原始串')
    await setCompileModeQueryRaw(electronApp, 'a=1&b')

    // Merely switching to 逐条 and back must not reserialize the string —
    // `showRows` only re-derives the ROW view from `query`, it never writes
    // `query` itself.
    await setCompileModeParamView(electronApp, '逐条')
    await setCompileModeParamView(electronApp, '原始串')
    const roundTripped = await readCompileModeQueryRaw(electronApp)
    expect(roundTripped, '只是看了一眼逐条视图，不应该把手打的原始串重新序列化').toBe('a=1&b')

    // An actual row edit DOES regenerate the string — editing `b`'s value
    // turns the bare `b` segment into `b=9`, proving the whole string was
    // rebuilt from the parsed rows rather than patched in place.
    await setCompileModeParamView(electronApp, '逐条')
    await editCompileModeParamRow(electronApp, 1, 'value', '9')
    await setCompileModeParamView(electronApp, '原始串')
    const regenerated = await readCompileModeQueryRaw(electronApp)
    expect(regenerated, '编辑逐条里的一行之后，原始串必须从解析结果重新生成').toBe('a=1&b=9')

    await cancelCompileModeForm(electronApp)
  })

  test('a new mode survives closing and reopening the project: toolbar label and menu entry both persist', async ({ electronApp }) => {
    await openCompileModePopover(workbench, electronApp)
    await clickCompileModeMenuAction(electronApp, '添加编译模式')
    await fillCompileModeForm(electronApp, { name: '重开保留模式', pathName: 'pages/storage-test/storage-test' })
    await submitCompileModeForm(electronApp)

    await pollUntil(
      () => readCompileModeToolbarLabel(workbench),
      (label) => label.includes('重开保留模式'),
      10_000,
      200,
    )

    await closeProject(electronApp)
    workbench = await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 10000 })

    // The toolbar's own label reflects the last selected mode straight from
    // the reloaded config, not just what an in-memory selection remembers —
    // reopening starts a fresh renderer state, so this only passes if the
    // mode round-tripped through project.config.json for real.
    const toolbarLabel = await pollUntil(
      () => readCompileModeToolbarLabel(workbench),
      (label) => label.includes('重开保留模式'),
      10_000,
      200,
    )
    expect(toolbarLabel, '重新打开项目后，工具栏必须仍然显示上次选中的自定义模式').toContain('重开保留模式')

    // The button's own text is no longer 普通编译 after reopening, so open
    // the popover by clicking the (now custom-labeled) button directly.
    await compileModeToolbarButton(workbench).click()
    await findPopoverWebContentsId(electronApp)
    const menuLabels = await readCompileModeMenuLabels(electronApp)
    expect(menuLabels, '重新打开项目后，菜单列表里必须仍然列着这个自定义模式').toContain('重开保留模式')
    await closeCompileModePopover(workbench)
  })
})
