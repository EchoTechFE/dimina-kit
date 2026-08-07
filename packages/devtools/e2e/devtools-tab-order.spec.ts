import { test, expect, useSharedProject } from './fixtures'
import type { ElectronApplication } from '@playwright/test'
import { DEMO_APP_DIR, pollUntil } from './helpers'

/** Resolve the right-panel Chrome DevTools front-end webContents by its URL. */
async function getRightPanelDevtoolsWcId(electronApp: ElectronApplication): Promise<number | null> {
  return electronApp.evaluate(({ webContents }) => {
    const front = webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed())
      .find((wc) => wc.getURL().startsWith('devtools://devtools/bundled/devtools_app.html'))
    return front ? front.id : null
  })
}

/** Execute JS inside the right-panel DevTools front-end realm. */
async function evalInRightPanelDevtools<T>(electronApp: ElectronApplication, expr: string): Promise<T> {
  const id = await getRightPanelDevtoolsWcId(electronApp)
  if (id === null) throw new Error('right-panel devtools front-end is not attached')
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id, expr }) as Promise<T>
}

// The DevTools front-end renders its panel tab bar inside shadow DOM, so plain
// document.querySelectorAll can't reach it. Mirror devtools-tabs.ts's deepCollect.
const DEEP_COLLECT_PREAMBLE = `
  function deepCollect(sel){ var out=[],stack=[document]; while(stack.length){ var root=stack.pop(); try{ var m=root.querySelectorAll?root.querySelectorAll(sel):[]; for(var i=0;i<m.length;i++)out.push(m[i]); }catch(_){} try{ var all=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var j=0;j<all.length;j++){ if(all[j].shadowRoot)stack.push(all[j].shadowRoot); } }catch(_){} } return out; }
  function txt(el){ return ((el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
  function visible(t){ try { return t.getClientRects().length > 0 && getComputedStyle(t).display !== 'none'; } catch(e){ return false; } }
`

test.describe('Right-panel DevTools tab bar (default order, Sources kept)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  useSharedProject(test, DEMO_APP_DIR)

  test('Elements / Console / Sources / Network all visible; Network click selects Network', async ({ mainWindow, electronApp }) => {
    // Open the Console panel so the embedded Chrome DevTools front-end is mounted.
    const consoleTab = mainWindow.getByRole('tab', { name: 'Console' })
    await consoleTab.click()
    await expect(consoleTab).toHaveAttribute('data-active', 'true')

    // Wait for the front-end realm to attach AND its tab bar to render.
    await pollUntil(
      () => evalInRightPanelDevtools<boolean>(electronApp, `(function(){${DEEP_COLLECT_PREAMBLE}
        var net = deepCollect('[role="tab"]').find(function(t){ var n=txt(t); return /^(Network|网络)$/.test(n); });
        return !!net;
      })()`).catch(() => false),
      (found) => found === true,
      30_000,
      300,
    )

    // All four kept tabs must be present in the DevTools default order.
    const barInfo = await evalInRightPanelDevtools<{
      netVisible: boolean
      srcVisible: boolean
      elementsVisible: boolean
      consoleVisible: boolean
    }>(electronApp, `(function(){${DEEP_COLLECT_PREAMBLE}
      var tabs = deepCollect('[role="tab"]');
      function find(re){ return tabs.find(function(t){ return re.test(txt(t)); }); }
      return {
        netVisible: !!(find(/^(Network|网络)$/) && visible(find(/^(Network|网络)$/))),
        srcVisible: !!(find(/^(Sources|来源|源代码)$/) && visible(find(/^(Sources|来源|源代码)$/))),
        elementsVisible: !!(find(/^(Elements|元素)$/) && visible(find(/^(Elements|元素)$/))),
        consoleVisible: !!(find(/^(Console|控制台)$/) && visible(find(/^(Console|控制台)$/))),
      };
    })()`)

    expect(barInfo.elementsVisible, 'Elements tab should be visible').toBe(true)
    expect(barInfo.consoleVisible, 'Console tab should be visible').toBe(true)
    expect(barInfo.srcVisible, 'Sources tab should be visible (default DevTools order)').toBe(true)
    expect(barInfo.netVisible, 'Network tab should be visible').toBe(true)

    // Click the Network tab inside the front-end and assert the active tab is Network.
    const clickResult = await evalInRightPanelDevtools<{
      clickedText: string
      activeText: string | null
    }>(electronApp, `(function(){${DEEP_COLLECT_PREAMBLE}
      var net = deepCollect('[role="tab"]').find(function(t){ var n=txt(t); return /^(Network|网络)$/.test(n); });
      if (!net) return { clickedText: 'not-found', activeText: null };
      var clickedText = txt(net);
      try { net.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); } catch(e) {}
      try { net.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })); } catch(e) {}
      try { net.click(); } catch(e) {}
      return new Promise(function(resolve){
        setTimeout(function(){
          var after = deepCollect('[role="tab"]').filter(visible);
          var active = after.find(function(t){
            return t.getAttribute('aria-selected') === 'true'
              || /(^|\\s)(tab-selected|tabbed-pane-tab-selected)(\\s|$)/.test(String(t.className || ''));
          });
          resolve({ clickedText: clickedText, activeText: active ? txt(active) : null });
        }, 200);
      });
    })()`)

    expect(clickResult.activeText).toBe(clickResult.clickedText)
  })
})
