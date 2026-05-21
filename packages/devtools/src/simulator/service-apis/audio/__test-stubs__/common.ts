/**
 * Test-only stub for the `../../../common` module that `service-apis/audio/
 * index.js` imports. At runtime that specifier resolves inside the dimina
 * submodule (service/src/api/common.js, supplied by build-container.js); it
 * does not exist as a source file in this package, so the unit test aliases
 * the specifier to this stub. The audio test always overrides it via
 * `vi.mock`, so the body here only needs to make the import resolvable.
 */
export function invokeAPI(..._args: unknown[]): void {}
