// Shared types for the ratchet engine and its adapters. One `Adapter` shape
// is the contract every dimension (cognitive-complexity, type-escapes,
// circular-deps, …) must satisfy so the engine can measure, snapshot, and
// gate them uniformly regardless of which underlying tool an adapter wraps.

export type Direction = 'lower-is-better' | 'higher-is-better';

// How `check` compares a re-measured value against the snapshot. Defaults to
// 'total' when an adapter omits it. See tools/ratchet/README.md for the
// per-mode rationale.
export type GateMode = 'total' | 'per-file-count' | 'per-key-value';

export type MeasureOptions = {
  // Overrides the scan root (used by tests to point an adapter at a fixture
  // directory instead of the real repo).
  root?: string;
};

// What an adapter's `measure()` resolves to. `unit` and `breakdown` are
// optional on the way out of an adapter — the engine normalizes them (unit
// defaults to 'count', breakdown to null) before writing a Metric.
export type MeasureResult = {
  value: number;
  unit?: string;
  breakdown?: Record<string, number> | null;
};

export type Adapter = {
  id: string;
  title: string;
  direction: Direction;
  gate?: GateMode;
  // Absolute slack (same unit as `value`) the gate grants against the
  // baseline: a change within it in the worse direction does not fail.
  // Meant for dimensions whose measurement carries inherent noise (e.g.
  // runtime coverage); omit for exact-count dimensions.
  tolerance?: number;
  measure: (opts?: MeasureOptions) => Promise<MeasureResult>;
};

// A measurement as stored in snapshot.json / returned by measureAll: fully
// normalized. `tolerance` is the one optional field — recorded only when the
// adapter declares it, so baseline-guard (which sees snapshots, not adapters)
// can honor the same slack the gate does.
export type Metric = {
  direction: Direction;
  value: number;
  unit: string;
  breakdown: Record<string, number> | null;
  tolerance?: number;
};

export type Snapshot = {
  metrics: Record<string, Metric>;
};
