# Plan: Implement `joinIsland` — Half-screen Bottom Popup

## Context

The Dynamic Island is the pill-shaped branding element at the top of the simulated iPhone frame (`dimina/fe/packages/container/src/pages/device/`). `joinIsland` is a new simple-trigger simulator API that shows a **half-screen popup sliding up from the bottom** (半屏弹窗). The user dismisses it by tapping the mask or a close button, which fires the `success` + `complete` callbacks.

## Architecture

Follow the existing overlay pattern exactly:

```
simulator-api-ui.ts  →  uiOverlayBus  →  <UiOverlay> (React)
     (handler)          (pub/sub)          (renderer)
```

## Changes (5 files)

### 1. `packages/devtools/src/simulator/ui-overlay-bus.ts`

Add a new dialog state variant for the half-sheet:

```ts
export interface HalfSheetDialogState {
  kind: 'halfSheet'
  /** Called when the user dismisses the sheet. */
  onDismiss: () => void
}
```

Extend the `DialogState` union:

```ts
export type DialogState = ModalDialogState | ActionSheetDialogState | HalfSheetDialogState
```

### 2. `packages/devtools/src/simulator/simulator-api-ui.ts`

Add a `joinIsland` export after `showActionSheet`. Pattern mirrors `showActionSheet`:

```ts
export function joinIsland(
  this: MiniAppContext,
  opts: { success?: unknown; fail?: unknown; complete?: unknown } = {},
) {
  const { onSuccess, onComplete } = bindCallbacks(this, opts)
  let settled = false
  uiOverlayBus.showDialog({
    kind: 'halfSheet',
    onDismiss: () => {
      if (settled) return
      settled = true
      uiOverlayBus.hideDialog()
      onSuccess?.({ errMsg: 'joinIsland:ok' })
      onComplete?.()
    },
  })
}
```

### 3. `packages/devtools/src/simulator/device-shell/ui-overlay.tsx`

- Import `HalfSheetDialogState` from the bus.
- Add a render branch in `UiOverlay`:
  ```tsx
  {dialog?.kind === 'halfSheet' && <HalfSheetView dialog={dialog} />}
  ```
- Add `HalfSheetView` component — a half-height bottom sheet with mask, close button, and a simple content area with the island/project info:
  ```tsx
  function HalfSheetView({ dialog }: { dialog: HalfSheetDialogState }) {
    return (
      <div className="dmui-overlay">
        <div className="dmui-mask" onClick={() => dialog.onDismiss()} />
        <div className="dmui-half-sheet" role="dialog" aria-modal="true">
          <div className="dmui-half-sheet__header">
            <span className="dmui-half-sheet__title">Island</span>
            <button type="button" className="dmui-half-sheet__close" onClick={() => dialog.onDismiss()}>
              &times;
            </button>
          </div>
          <div className="dmui-half-sheet__body">
            <p>Welcome to the Island.</p>
          </div>
        </div>
      </div>
    )
  }
  ```

### 4. `packages/devtools/src/simulator/device-shell/ui-overlay.css`

Add CSS for the half-sheet, following the existing action-sheet alignment pattern:

```css
/* ── Half sheet ──────────────────────────────────────────────────────────── */
.dmui-overlay:has(.dmui-half-sheet) {
  align-items: flex-end;
}

.dmui-half-sheet {
  position: relative;
  width: 100%;
  height: 50%;
  background: #fff;
  border-radius: 12px 12px 0 0;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  animation: dmui-slide-up 0.3s ease-out;
}

@keyframes dmui-slide-up {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}

.dmui-half-sheet__header { ... }  /* flex row, title + close button */
.dmui-half-sheet__body   { ... }  /* flex:1, overflow-y:auto, padding */
.dmui-half-sheet__close  { ... }  /* 32x32 close button top-right */
```

### 5. `packages/devtools/src/simulator/simulator-api.ts`

- Add `joinIsland` to the import from `'./simulator-api-ui'`.
- Add `joinIsland` to the `simulatorApis` object under a new "UI: Half Sheet" section (after `showActionSheet`).

### 6. New test: `packages/devtools/src/simulator/simulator-api-join-island.test.ts`

Test cases (following `simulator-api-ui.test.ts` patterns):
- Pushes a dialog with `kind === 'halfSheet'`
- Does NOT fire success/complete before user dismisses
- Fires success with `{ errMsg: 'joinIsland:ok' }` when `onDismiss()` is called
- Fires complete when `onDismiss()` is called
- Clears dialog to null after dismiss
- Double-settle guard: fires success/complete exactly once on repeated `onDismiss()` calls

## Verification

```bash
cd packages/devtools
npx vitest run src/simulator/simulator-api-join-island.test.ts   # new tests
pnpm lint                                                         # zero warnings
pnpm ratchet:check                                                # no regressions
```

Manual: `pnpm dev` → open a mini-app → call `wx.joinIsland()` → verify half-sheet slides up from bottom, dismiss via mask or close button.
