/**
 * Pure line filter for dmcc (`@dimina/compiler`) terminal output.
 *
 * The compiler + its listr2 renderer write directly to stdout/stderr. In the
 * fork architecture the parent reads the worker's piped streams and runs every
 * line through this filter before delivering it to `onLog`. DROP rules are
 * derived from real captured output (`.repro/dmcc-log-spike/`); everything
 * else is KEPT (default-keep), so unanticipated high-value lines — e.g.
 * esbuild's `<stdin>:L:C: ERROR: …` detail — always survive.
 */

// CSI escape sequences (colors, erase-line, cursor moves) as emitted by
// chalk / listr2 TTY renderers.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g

const DROP_RULES: RegExp[] = [
	// dmcc logo banner (art.js): box-drawing characters only.
	/^[█╔╗╚╝═║\s]+$/,
	// `❯ ` listr task-start lines — transient noise; ✔/✖ cover the outcome.
	/^❯ /,
	// `› [██░░] %` per-worker progress-bar lines.
	/^› \[/,
	// devkit fe-server banner — the port is already surfaced via session.port.
	/^Server is running on port /,
	/^Press Ctrl\+C to stop/,
	// Stack-trace frames (esbuild / Node internals) — the message line above
	// them is kept; frames are noise for a compile panel.
	/^\s+at /,
	// Node process-level DeprecationWarnings + the `--trace-deprecation` hint
	// Node prints after the first one. The developer's code never runs in the
	// compile worker, so these are never actionable in a compile panel. Packaged
	// Electron apps ALWAYS emit one: the asar fs shim's asarStatsToFsStats uses
	// the deprecated fs.Stats constructor (electron/electron#47390), so the
	// first stat of an in-asar file prints the DEP0180 pair to stderr. Only the
	// DeprecationWarning form is dropped — other `(node:pid)` warnings
	// (MaxListenersExceeded, Experimental) can carry real signal and are kept.
	/^\(node:\d+\) (?:\[DEP\d+\] )?DeprecationWarning: /,
	/^\(Use `.+--trace-deprecation .*` to show where the warning was created\)/,
]

/**
 * Strip ANSI escapes, then decide keep/drop. Returns the cleaned line, or
 * `null` when the line is known noise (or empty once stripped).
 */
export function filterDmccLogLine(line: string): string | null {
	const cleaned = line.replace(ANSI_RE, '')
	if (cleaned.trim() === '') return null
	for (const rule of DROP_RULES) {
		if (rule.test(cleaned)) return null
	}
	return cleaned
}
