/**
 * Test-only setup for the `dock-react` jsdom suite.
 *
 * `react-resizable-panels` touches `ResizeObserver` inside its mount layout
 * effect (`mountGroup`), and jsdom does not provide one — without this the
 * `<Group>` mount throws "n is not a constructor". This is pure test infra; it
 * is NOT part of the published bundle (excluded from the declaration build via
 * the `*.test.ts` glob in tsconfig.build.json) and the contract assertions live
 * in `dock-view.test.tsx`.
 */
class StubResizeObserver implements ResizeObserver {
	observe(): void { /* noop */ }
	unobserve(): void { /* noop */ }
	disconnect(): void { /* noop */ }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
	globalThis.ResizeObserver = StubResizeObserver
}
