/**
 * Shared splitter / resize-handle styling.
 *
 * Both kinds of workbench divider use these so they render as a single,
 * consistent line:
 *   - manual sim-column `Splitter` (plain-flex Row in `frame-tree.tsx`)
 *   - `react-resizable-panels` `ResizeHandle` (resizable groups)
 *
 * Design contract:
 *   - Hit area stays generous (10px) so the divider is easy to grab.
 *   - The *visible* bar is 1px (`w-px` / `h-px`, set by each caller per
 *     orientation) so the line reads thin, not chunky.
 *   - Color is the design-token border by default, elevated to the ring
 *     token (`--color-ring`) on hover / active.
 */

/** Orientation of the *visible line*, not the drag axis:
 *  - `vertical`   → a vertical line (column split, drag horizontally)
 *  - `horizontal` → a horizontal line (row split, drag vertically) */
export type SplitterOrientation = "vertical" | "horizontal"

/**
 * Transparent 10px hit zone that centers the visible bar. The element
 * itself carries no color — `splitterVisibleBar` does.
 */
export function splitterHitArea(orientation: SplitterOrientation): string {
  return [
    "group relative flex items-center justify-center bg-transparent shrink-0",
    orientation === "vertical"
      ? "h-full w-[10px] cursor-col-resize"
      : "w-full h-[10px] cursor-row-resize",
  ].join(" ")
}

/**
 * Base classes for the rendered 1px line — color + hover only. The caller
 * appends the orientation-specific size (`h-full w-px` / `h-px w-full`) and,
 * for the resizable handle, the `data-resize-handle-active` variant.
 */
export const splitterVisibleBar =
  "bg-border transition-colors group-hover:bg-ring"
