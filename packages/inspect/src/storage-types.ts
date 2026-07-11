// Wire-format types for mini-program Storage inspection. Hosts transport
// them over IPC, postMessage, or read them straight off a shared
// localStorage — the shapes are the contract, not the transport.

/** One storage entry. `key` carries the full `${appId}_` namespace prefix;
 * values are the raw localStorage strings (objects are JSON-stringified by
 * the runtime before they land here). */
export interface StorageItem {
  key: string
  value: string
}

/** An incremental storage mutation pushed by a host's change feed (CDP
 * DOMStorage events, `storage` DOM events, or synthesized after the host's
 * own writes). Keys carry the full prefix, same as StorageItem. */
export type StorageEvent =
  | { type: 'added', key: string, newValue: string }
  | { type: 'updated', key: string, oldValue: string, newValue: string }
  | { type: 'removed', key: string }
  | { type: 'cleared' }

/** Result of a panel-initiated write. Failures carry a user-displayable
 * message; the panel surfaces it inline instead of throwing. */
export type StorageWriteResult =
  | { ok: true }
  | { ok: false, error: string }
