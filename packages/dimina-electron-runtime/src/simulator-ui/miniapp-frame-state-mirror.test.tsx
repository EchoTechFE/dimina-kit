/** @vitest-environment jsdom */
/**
 * The frame keeps a mirror of its committed state for the bridge listeners to
 * reduce from, because bridge events arrive outside React's rendering. The
 * mirror's contract has two halves, and each half needs its own kind of test:
 *
 * 1. It advances synchronously, at the moment a state is committed — the
 *    behavior cases below drive two or three dynamic updates through the bridge
 *    and assert the later ones reduce from the state its predecessor committed.
 * 2. `commitShell` / `commitTabBar` are its only writers. No behavior case can
 *    cover this half: every one of them runs inside `act()`, which drains React's
 *    passive effects before the assertions, so an effect that re-syncs the mirror
 *    from render state stays invisible here while dragging the mirror back to a
 *    pre-event snapshot in production. The structural guard at the bottom is the
 *    one that fails when such a writer appears.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from '@testing-library/react'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels.js'
import {
  APP_SESSION_ID,
  bootShell,
  HOME_PAGE,
  ROOT_BRIDGE_ID,
  type HostRecorder,
} from './__test-stubs__/miniapp-frame-harness.js'


function fireNavBar(
  recorder: HostRecorder,
  name: string,
  params: Record<string, unknown>,
): void {
  recorder.fire(E.NAV_BAR, { bridgeId: ROOT_BRIDGE_ID, name, params })
}

function fireTabAction(
  recorder: HostRecorder,
  name: string,
  params: Record<string, unknown>,
): void {
  recorder.fire(E.TAB_ACTION, {
    appSessionId: APP_SESSION_ID,
    bridgeId: ROOT_BRIDGE_ID,
    name,
    params,
    callbacks: {},
  })
}

/** Runs the fires in one tick and lets React finish rendering and its effects. */
async function inOneTick(fn: () => void): Promise<void> {
  await act(async () => { fn() })
}

function titleText(container: HTMLElement): string | null {
  return container.querySelector('.nav-bar__title-text')?.textContent ?? null
}

function navBarBackground(container: HTMLElement): string {
  return (container.querySelector('.nav-bar') as HTMLElement).style.backgroundColor
}

function badgeText(container: HTMLElement): string | null {
  return container.querySelector('.dmb-tab-bar__badge')?.textContent ?? null
}

function tabBarPresent(container: HTMLElement): boolean {
  return !!container.querySelector('.dmb-tab-bar')
}

describe('MiniAppFrame — two navigation-bar updates arrive in one tick', () => {
  it('reduces the second update from the state the first synchronously committed', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)

    await inOneTick(() => {
      fireNavBar(recorder, 'setNavigationBarTitle', { title: 'Checkout' })
      fireNavBar(recorder, 'setNavigationBarColor', { backgroundColor: '#123456' })
    })

    expect(titleText(container)).toBe('Checkout')
    expect(navBarBackground(container)).toBe('rgb(18, 52, 86)')
  })
})

describe('MiniAppFrame — a navigation-bar update precedes a full React flush', () => {
  it('carries its committed state into the next update', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)

    await inOneTick(() => { fireNavBar(recorder, 'setNavigationBarTitle', { title: 'Checkout' }) })
    expect(titleText(container)).toBe('Checkout')

    await inOneTick(() => { fireNavBar(recorder, 'showNavigationBarLoading', {}) })

    expect(titleText(container)).toBe('Checkout')
    expect(container.querySelector('.nav-bar__spinner')).not.toBeNull()
  })
})

describe('MiniAppFrame — two tabBar actions arrive in one tick', () => {
  it('reduces the second action from the state the first synchronously committed', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)

    await inOneTick(() => {
      fireTabAction(recorder, 'setTabBarBadge', { index: 0, text: '5' })
      fireTabAction(recorder, 'hideTabBar', {})
    })
    expect(tabBarPresent(container)).toBe(false)

    await inOneTick(() => { fireTabAction(recorder, 'showTabBar', {}) })

    // A hideTabBar reduced from the pre-badge snapshot would have dropped the
    // badge along the way, and showing the bar again would reveal it gone.
    expect(badgeText(container)).toBe('5')
  })
})

describe('MiniAppFrame — a tabBar action precedes a full React flush', () => {
  it('carries its committed state into the next action', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)

    await inOneTick(() => { fireTabAction(recorder, 'setTabBarBadge', { index: 0, text: '5' }) })
    expect(badgeText(container)).toBe('5')

    await inOneTick(() => { fireTabAction(recorder, 'showTabBarRedDot', { index: 1 }) })

    expect(badgeText(container)).toBe('5')
    expect(container.querySelector('.dmb-tab-bar__red-dot')).not.toBeNull()
  })
})

// ── Structural guard: who is allowed to write the mirror ────────────────────

const SHELL_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'miniapp-frame.tsx',
)

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/** The expression an assignment or ++/-- writes to, or null for other nodes. */
function assignedTarget(node: ts.Node): ts.Expression | null {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return node.left
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken
      || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand
  }
  return null
}

/**
 * Whether a write target is `stateRef.current` or reaches through it
 * (`stateRef.current.shell`). Other refs in this component are none of this
 * guard's business — only the mirror has the commit-time-write contract.
 */
function writesStateRef(target: ts.Expression): boolean {
  let cursor: ts.Node = target
  while (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
    if (
      ts.isPropertyAccessExpression(cursor)
      && cursor.name.text === 'current'
      && ts.isIdentifier(cursor.expression)
      && cursor.expression.text === 'stateRef'
    ) {
      return true
    }
    cursor = cursor.expression
  }
  return false
}

function parseShellSource(): ts.SourceFile {
  return ts.createSourceFile(
    'miniapp-frame.tsx',
    readFileSync(SHELL_SOURCE_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
}

function collect(file: ts.SourceFile, pick: (node: ts.Node) => string | null): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const hit = pick(node)
    if (hit !== null) found.push(hit)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('miniapp-frame.tsx — the state mirror has no writer outside its commit points', () => {
  it('declares the mirror under the name this guard matches on', () => {
    const file = parseShellSource()
    const declarations = collect(file, (node) =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'stateRef'
        ? node.getText(file)
        : null)

    // Renaming the ref would silently defeat the assignment guard below.
    expect(declarations).toHaveLength(1)
    expect(declarations[0]).toContain('useRef')
  })

  it('assigns stateRef.current nowhere in the component body', () => {
    const file = parseShellSource()
    const writes = collect(file, (node) => {
      const target = assignedTarget(node)
      if (!target || !writesStateRef(target)) return null
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      return `${line + 1}: ${node.getText(file).split('\n')[0].trim()}`
    })

    // commitShell / commitTabBar are the mirror's only authorized writers; a
    // second one — most plausibly an effect re-syncing it from render state —
    // makes the mirror lag a commit behind for every bridge event.
    expect(writes).toEqual([])
  })
})
