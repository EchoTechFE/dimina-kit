#!/usr/bin/env node
// Thin bridge from pawl's exec-adapter contract to the ratchet adapters under
// ./adapters — each adapter's measure() is the single source of the number, so
// the value pawl gates on is exactly the value the adapter tests exercise.
//
// Usage: node tools/ratchet/pawl-adapter.ts <adapter-id>
//
// Contract (see /Volumes/jdisk/code/pawl/internal/pawl/measure.go
// parseAdapterOutput): exit 0 with exactly one JSON object on stdout —
// {"value": number, "unit"?: string, "breakdown"?: object|null} — or a
// non-zero exit for any failure. All diagnostics go to stderr; stdout
// carries nothing else, or pawl's "not a single JSON object" guard rejects
// the measurement outright rather than reading a truncated/chatty stream as
// a real number.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Adapter } from './lib/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(HERE, 'adapters');

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: node tools/ratchet/pawl-adapter.ts <adapter-id>');
    process.exit(2);
  }

  const adapterPath = join(ADAPTERS_DIR, `${id}.ts`);
  let mod: { default: Adapter };
  try {
    mod = (await import(pathToFileURL(adapterPath).href)) as { default: Adapter };
  } catch (e) {
    console.error(`pawl-adapter: failed to load adapter "${id}" from ${adapterPath}: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const adapter = mod.default;
  if (!adapter || typeof adapter.measure !== 'function') {
    console.error(`pawl-adapter: ${adapterPath} has no default Adapter export with a measure() function`);
    process.exit(2);
    return;
  }

  try {
    const result = await adapter.measure();
    // Normalize measure()'s result into pawl's exec JSON: unit defaults to
    // 'count' (the Adapter type carries no top-level unit, only the result
    // does), and an empty breakdown collapses to null so pawl treats it as
    // "no per-key detail" rather than an empty gate set.
    process.stdout.write(
      JSON.stringify({
        value: result.value,
        unit: result.unit ?? 'count',
        breakdown: result.breakdown && Object.keys(result.breakdown).length > 0 ? result.breakdown : null,
      }) + '\n',
    );
  } catch (e) {
    console.error(`pawl-adapter: measure() for "${id}" failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
