# Copilot code review — dimina-kit

These instructions apply to **every** pull request in this repository, not to any single change or feature branch.

## Mandatory project rules (must follow)

You **must** read and **must** follow these files for every review. They are authoritative. Do not invent conflicting criteria; if anything in this file or your defaults disagrees with them, **those files win**.

1. **`CLAUDE.md`** (repository root) — kit-side design principles, multi-round review methodology, lint/pawl gates, submodule protection, comment norms. Treat every rule in it as binding for this review.
2. **`dimina/AGENTS.md`** — upstream Dimina agent entry. You **must** follow it and any documents it requires (including `dimina/docs/Experience-Review.md`) for framework / compiler / render / native semantics.

A review that skips either file, or that contradicts them, is invalid. Prefer fixing at the correct layer (upstream vs kit adapter); never treat demo/fixture patches as the long-term fix.

## Review posture

Apply the rules above first. In addition:

- Defect-first. Cite `file:line`. Skip style-only nits unless they hide a bug.
- Reject hardcoded delays that paper over races; require real ordering / generation fixes.
- Reject duplicate ownership of the same state or decision (single source of truth).
- Late async results must be epoch/generation-gated; do not revive disposed sessions.
- Custom Electron protocols used as documents or for ES modules need privileged registration (`standard` + `supportFetchAPI`) before `app.whenReady`, merged into the host's single `registerSchemesAsPrivileged` call.
- Do not approve edits under `dimina/` unless the PR explicitly records developer approval.
- Behavioral fixes need a regression test (unit or e2e). New files must stay ≤500 lines (pawl `file-length`).

## Language

Review in Chinese when the PR description or majority of touched comments are Chinese; otherwise English is fine.
