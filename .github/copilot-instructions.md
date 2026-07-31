# Copilot code review — dimina-kit

Prefer defect-first reviews. Cite `file:line`. Skip style-only nits unless they hide a bug.

## Must check

- **Correct layer**: fix framework/runtime/devtools adapter bugs in the right package; never in demo/fixture business code as a long-term fix.
- **No hardcoded delays** (`setTimeout` / fixed sleeps) to paper over races — require a real ordering/generation fix.
- **Single source of truth**: reject duplicate ownership of the same state/decision.
- **Async races**: late callbacks must be epoch/generation-gated; do not revive disposed sessions/editors.
- **Privileged Electron schemes**: custom protocols used for documents or ES modules need `registerSchemesAsPrivileged` (`standard` + `supportFetchAPI`) before `app.whenReady`, merged into the host's single registration call.
- **`dimina/` submodule**: do not approve changes under `dimina/` unless the PR explicitly documents developer approval.
- **Tests**: behavioral fixes need a failing-first regression (unit or e2e). New files must stay ≤500 lines (pawl `file-length`).

## This repo's runtime shape

- `dimina-electron-runtime` is an embeddable host SDK; end-to-end UI flows may still live in `@dimina-kit/devtools` e2e until a runtime harness exists.
- `dmb-resource://<bridgeId>/…` serves `/__sdk__/*` from runtime dist and proxies other paths to the session `resourceBaseUrl`.

Review comments in Chinese when the PR is authored in Chinese; otherwise English is fine.
