// Shared harness for the workspace-service concurrent-lifecycle suites
// (workspace-lifecycle-race.test.ts): spy-instrumented views, minimal
// WorkbenchContext stubs, and a close-behavior harness for the isClosing
// tests. Pure vi.fn factories — the electron/fs/module mocks stay in the
// test file (vi.mock is hoisted per test module and cannot live here).
import { vi } from 'vitest'

// The narrow ctx shape createWorkspaceService actually takes, derived from its
// signature — no direct workbench-context type dependency from this layer.
type WorkbenchContext = Parameters<typeof import('./workspace-service.js').createWorkspaceService>[0]

export function stubProjectsProvider(): import('../projects/types.js').ProjectsProvider {
	return {
		listProjects: vi.fn(() => []),
		addProject: vi.fn((p: string) => ({ name: 'fake', path: p, lastOpened: null })),
		removeProject: vi.fn(),
	}
}

export function makeViewsSpy() {
	const events: string[] = []
	const views = {
		disposeAll: vi.fn(() => { events.push('views.disposeAll') }),
		// Project-scoped teardown: closeProject must call THIS, never disposeAll
		// (which would also kill the host toolbar — see view-manager-dispose-scopes.test.ts).
		disposeProjectViews: vi.fn(() => { events.push('views.disposeProjectViews') }),
		detachWorkbench: vi.fn(() => { events.push('views.detachWorkbench') }),
		detachSimulator: vi.fn(() => { events.push('views.detachSimulator') }),
	}
	return { views, events }
}

export function makeCtxWith(
	views: ReturnType<typeof makeViewsSpy>['views'],
	adapter: { openProject: ReturnType<typeof vi.fn> },
) {
	return {
		adapter,
		notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
		views,
		projectsProvider: stubProjectsProvider(),
	} as unknown as WorkbenchContext
}

// Minimal harness for the isClosing tests: sessions whose close() calls the given behavior.
export function makeClosingHarness(closeBehavior: () => Promise<void>) {
	const adapter = {
		openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => ({
			port: 7788,
			appInfo: { appId: `app:${projectPath}` },
			close: vi.fn(closeBehavior),
		})),
	}
	const views = {
		disposeAll: vi.fn(),
		disposeProjectViews: vi.fn(),
		detachWorkbench: vi.fn(),
		detachSimulator: vi.fn(),
	}
	return {
		ctx: {
			adapter,
			notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
			views,
			projectsProvider: stubProjectsProvider(),
		} as unknown as WorkbenchContext,
	}
}
