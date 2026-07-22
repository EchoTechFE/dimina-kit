import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Select } from "@/shared/components/ui/select";
import {
  createPlacementAnchor,
  type Bounds,
  type Placement,
  type PlacementAnchorHandle,
} from "@dimina-kit/view-anchor";
import { usePlacementPublisher } from "../placement-publisher-context";
import { VIEW_ID, VIEW_LAYER } from "../../../../../../shared/view-ids";
import { useDockLayoutEpoch } from "@dimina-kit/electron-deck/dock-react";
import { cn } from "@/shared/lib/utils";
import {
  AUTO_ZOOM,
  DEVICES,
  ZOOM_OPTIONS,
  type ZoomSetting,
} from "@/shared/constants";
import {
  FallbackBanner,
  RuntimeErrorOverlay,
  WatcherDeadBar,
  type SimulatorRuntimeStatus,
} from "./simulator-runtime-banners";

interface Device {
  name: string;
  width: number;
  height: number;
}

interface SimulatorPanelProps {
  device: Device;
  zoom: ZoomSetting;
  onDeviceChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onZoomChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  compileStatus: { status: string; message: string };
  currentPage: string;
  copied: boolean;
  onCopyPagePath: () => void;
  /** Latest runtime-lifecycle push for the active session; null when healthy/unreported. Optional for embedders that don't wire runtime-status (defaults to null: no overlay/banner). */
  runtimeStatus?: SimulatorRuntimeStatus | null;
  /** True once the project's file watcher has died for this session. */
  watcherDead?: boolean;
  /** Re-runs the current launch config (the toolbar's existing 刷新/relaunch action). */
  onRelaunch?: () => void;
  /** Opens the standalone internal (app-wide) DevTools debug window. Unlike
   * the page-path copy button, debugging the whole app is independent of the
   * current page, so the button always renders. */
  onOpenInternalDevtools?: () => void;
}

// DeviceShell's scrollable desk reserves 24px on each edge and the handset has
// a 1px border on each edge. Auto-fit must include this fixed frame or a phone
// that numerically matches its region still overflows by a few pixels.
const AUTO_FIT_FRAME = 2 * (24 + 1);

// Resolves the auto-fit zoom percent from the measured device-region box: the
// largest whole-percent scale (capped at 100) that lets the framed device fit
// inside `bounds` without cropping either axis. Rounding down deliberately
// leaves a small safety margin, avoiding a native scrollbar from fractional
// device-pixel rounding. A zero-area measurement (unstable first layout, or a
// guardDisplayNone hidden tick) returns `fallback` unchanged instead of
// collapsing to 0.
function computeAutoZoom(
  bounds: Bounds,
  device: { width: number; height: number },
  fallback: number,
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return fallback;
  const ratio = Math.min(
    bounds.width / (device.width + AUTO_FIT_FRAME),
    bounds.height / (device.height + AUTO_FIT_FRAME),
  );
  return Math.max(1, Math.min(100, Math.floor(ratio * 100)));
}

export function SimulatorPanel({
  device,
  zoom,
  onDeviceChange,
  onZoomChange,
  compileStatus,
  currentPage,
  copied,
  onCopyPagePath,
  runtimeStatus = null,
  watcherDead = false,
  onRelaunch = () => {},
  onOpenInternalDevtools = () => {},
}: SimulatorPanelProps) {
  // The simulator is a main-process WebContentsView (native-host is the sole
  // runtime) painted directly over the flex:1 placeholder below. This renderer
  // panel draws NO phone/bezel: just the toolbar, an EMPTY placeholder slot, and
  // the page-path bar. Inside the WCV, DeviceShell draws the WHOLE phone (rounded
  // corners, notch, nav, viewport, tab/home) at FIXED device-logical size and
  // scrolls it natively when larger than the region. zoom is applied as the
  // WCV's zoomFactor (zoom/100), never as a CSS transform here.
  //
  // This component is the SOLE simulator-WCV anchor owner. It binds an imperative
  // `createPlacementAnchor` to the device-region div (NOT the engine-agnostic
  // `useViewAnchor`). The simulator dock leaf is `minPx`-floored (flexible above
  // the device width), so dragging an adjacent splitter both SHIFTS and RESIZES
  // it. `followGeometry: true` opens a windowed RAF geometry sentinel that
  // re-publishes the live rect (position AND size) frame-by-frame, so the WCV
  // tracks the column as the user widens it (the DeviceShell inside keeps the
  // phone at device-logical size and centers it on its gray desk). The WCV is
  // a main-process child view. Under DOM-panel keepalive (A3) SimulatorPanel is
  // NOT unmounted when its dock tab deactivates — its slot merely goes
  // `display:none` — so there is no unmount path to publish hidden on a tab
  // switch. To collapse the WCV on deactivation it opts into view-anchor's
  // `guardDisplayNone`: that installs an IntersectionObserver which re-fires on a
  // `display:none` transition (invisible to ResizeObserver) and turns the
  // resulting zero-area measure into a `{ visible:false }` publish, which the
  // `publish` callback below maps to COLLAPSED 0×0 bounds (detaching the WCV).
  // The true unmount path still publishes hidden + disposes as a safety net.
  //
  // Zoom rides in the publish payload (the `Placement` rect has no zoom field) so
  // main can `setZoomFactor` the WCV; it is kept in a ref so the imperative
  // publisher always reads the LIVE value, and a zoom change forces one
  // re-publish.
  // Holds the last RESOLVED numeric zoom (never AUTO_ZOOM) — what actually
  // rides in the publish payload. Seeded with a number even when the initial
  // selection is 'auto', so the very first publish (before any measurement)
  // never carries a non-numeric value across the extra.zoom → IPC boundary.
  const zoomRef = useRef<number>(typeof zoom === "number" ? zoom : 100);
  // The user's raw selection (a fixed percent, or 'auto'). Read live inside
  // `publish` via ref so that callback's identity can stay pinned to
  // `[publisher]` instead of being recreated on every zoom change.
  const zoomModeRef = useRef<ZoomSetting>(zoom);
  // Device dimensions, read live inside `publish` for the same reason.
  const deviceRef = useRef(device);
  const anchorHandleRef = useRef<PlacementAnchorHandle | null>(null);

  // Whether the simulator has reached 'ready' at least once since mount. The
  // first compile has NOTHING to show behind it, so 'compiling' blanks the
  // region with a full overlay. A RECOMPILE, by contrast, keeps the live phone
  // shell painted underneath — blanking it would flash the whole device away on
  // every save. So once ready, a subsequent 'compiling' shows only a
  // non-blocking corner indicator and the frozen previous frame stays visible.
  const [hasBeenReady, setHasBeenReady] = useState(false);
  useEffect(() => {
    if (compileStatus.status === "ready") setHasBeenReady(true);
  }, [compileStatus.status]);

  // Runtime-lifecycle derived flags. A compile failure has nothing running to
  // report on, so it always wins over a runtime error — the two overlays are
  // mutually exclusive.
  const isRuntimeTerminalError =
    runtimeStatus?.phase === "launch-failed" ||
    runtimeStatus?.phase === "crashed";

  // Fallback-banner dismissal: remembered only for the CURRENT launch round.
  // `runtimeStatus` is reset to null the moment a new round starts (hot-reload
  // reset in use-session), so clearing the dismissal on that null edge means a
  // repeat fallback in a later round is never silently swallowed.
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  useEffect(() => {
    if (!runtimeStatus) setFallbackDismissed(false);
  }, [runtimeStatus]);
  const showFallbackBanner =
    Boolean(runtimeStatus?.pageFallback) &&
    !isRuntimeTerminalError &&
    !fallbackDismissed;
  const isRecompile = compileStatus.status === "compiling" && hasBeenReady;

  const publisher = usePlacementPublisher();
  // Placement flows to the central publisher; zoom rides in `extra` (the
  // Placement bounds have no zoom field) so an extra-only change still emits a
  // setBounds op that re-applies the WCV zoomFactor.
  const publish = useCallback(
    (p: Placement) => {
      if (p.visible) {
        const mode = zoomModeRef.current;
        zoomRef.current =
          mode === AUTO_ZOOM
            ? computeAutoZoom(p.bounds, deviceRef.current, zoomRef.current)
            : mode;
      }
      publisher?.set({
        viewId: VIEW_ID.simulator,
        placement: p,
        layer: VIEW_LAYER.base,
        extra: { zoom: zoomRef.current },
      });
    },
    [publisher],
  );

  // Ref-callback binding the placement anchor to the device-region div. Mirrors
  // the dock native-slot lifecycle: bind on mount, rebind without a hidden flash
  // on element swap, publish-hidden-then-dispose on unmount.
  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      const existing = anchorHandleRef.current;
      if (existing) {
        if (el) {
          existing.dispose();
          anchorHandleRef.current = createPlacementAnchor(el, {
            visible: true,
            followGeometry: true,
            guardDisplayNone: true,
            publish,
          });
        } else {
          existing.update({ visible: false, publish });
          existing.dispose();
          anchorHandleRef.current = null;
        }
        return;
      }
      if (el) {
        anchorHandleRef.current = createPlacementAnchor(el, {
          visible: true,
          followGeometry: true,
          guardDisplayNone: true,
          publish,
        });
      }
    },
    [publish],
  );

  // Keep the live zoom in the ref BEFORE paint (so a geometry event firing
  // between commit and a passive effect never reads a stale zoom), then force one
  // re-publish so main re-applies `setZoomFactor` on zoom change.
  useLayoutEffect(() => {
    zoomModeRef.current = zoom;
    deviceRef.current = device;
  });
  useLayoutEffect(() => {
    anchorHandleRef.current?.update({ visible: true, publish });
  }, [zoom, device, publish]);

  // Follow a pure-translate layout reorder. A dock preset change (simulator
  // left↔right flip, devtools-position move) reorders this panel's slot
  // horizontally without resizing it, so the anchor's ResizeObserver never fires
  // and the native WCV would freeze at its old x. `useDockLayoutEpoch` bumps on
  // every committed layout mutation; pulsing the anchor on that edge opens the
  // `followGeometry` RAF sentinel for a few frames AFTER React commits the
  // reorder, re-measuring the moved slot and re-publishing the rect (the
  // sentinel auto-closes once the geometry goes steady). The bounded duration is
  // an upper guard against a commit deferred past the next frame. The mount run
  // (epoch 0) pulses once over the just-published initial rect — a harmless
  // steady-close. Outside a `<DockView>` the epoch is a constant 0 and this
  // never re-fires.
  const layoutEpoch = useDockLayoutEpoch();
  useEffect(() => {
    anchorHandleRef.current?.pulse(300);
  }, [layoutEpoch]);

  // Hard-unmount safety: the ref-callback `null` cleanup also disposes, but a
  // teardown that skips the ref cleanup must not leak a live anchor.
  useEffect(() => {
    return () => {
      anchorHandleRef.current?.dispose();
      anchorHandleRef.current = null;
      publisher?.remove(VIEW_ID.simulator);
    };
  }, [publisher]);

  return (
    <div className="bg-sim-bg flex flex-col overflow-hidden h-full w-full">
      <div className="flex items-center gap-2 px-5 py-2 shrink-0 border-b border-border-subtle">
        <Select value={device.name} onChange={onDeviceChange}>
          {DEVICES.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select
          value={zoom}
          onChange={onZoomChange}
          className="w-[76px] shrink-0"
        >
          {ZOOM_OPTIONS.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
          <option value={AUTO_ZOOM}>自适应</option>
        </Select>
      </div>

      {/* Persistent, never covers the device region below (contract: "不遮内容"). */}
      {watcherDead && <WatcherDeadBar />}
      {showFallbackBanner && runtimeStatus?.pageFallback && (
        <FallbackBanner
          requested={runtimeStatus.pageFallback.requested}
          resolved={runtimeStatus.pageFallback.resolved}
          onDismiss={() => setFallbackDismissed(true)}
        />
      )}

      <div
        ref={anchorRef}
        className="flex-1 min-h-0 bg-sim-bg relative"
        data-area="native-simulator"
      >
        {/* The simulator itself is a main-process WebContentsView (mounted via
            attachNativeSimulator) painted over this placeholder region — it
            hosts DeviceShell, which draws the whole phone and scrolls it
            natively, so the renderer never renders a `<webview>` here. */}
        {compileStatus.status === "compiling" && !hasBeenReady && (
          <div
            data-testid="sim-compiling-overlay"
            className="absolute inset-0 flex items-center justify-center bg-black/50 z-10"
          >
            <div className="text-text-dim text-[13px]">正在编译中...</div>
          </div>
        )}
        {isRecompile && (
          <div
            data-testid="sim-recompiling-indicator"
            className="absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded bg-black/60 px-2 py-0.5 pointer-events-none"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-text-dim text-[11px]">编译中…</span>
          </div>
        )}
        {compileStatus.status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
            <div className="text-center p-4">
              <div className="text-status-error text-[14px] font-medium mb-2">
                编译失败
              </div>
              <div className="text-status-error text-[11px] max-w-[280px] break-words">
                {compileStatus.message}
              </div>
            </div>
          </div>
        )}
        {/* Compile failure always wins when both are true. */}
        {compileStatus.status !== "error" &&
          runtimeStatus &&
          (runtimeStatus.phase === "launch-failed" ||
            runtimeStatus.phase === "crashed") && (
            <RuntimeErrorOverlay
              phase={runtimeStatus.phase}
              code={runtimeStatus.code}
              reason={runtimeStatus.reason}
              onRelaunch={onRelaunch}
            />
          )}
      </div>

      <div className="flex items-center px-2.5 bg-sim-bottom border-t border-border-subtle shrink-0 h-[30px] min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[11px] text-text-dim truncate min-w-0">
            {currentPage || "—"}
          </span>
          {currentPage && (
            <button
              className={cn(
                "shrink-0 flex items-center justify-center w-4 h-4 rounded transition-colors",
                copied ? "text-accent" : "text-text-dim hover:text-text",
              )}
              onClick={onCopyPagePath}
              title="复制路径"
            >
              {copied ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline
                    points="1.5,5 4,7.5 8.5,2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect
                    x="1"
                    y="3"
                    width="6"
                    height="6.5"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                  <path
                    d="M3 3V2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H7"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                </svg>
              )}
            </button>
          )}
        </div>

        {/* Opens the standalone internal (app-wide) DevTools debug window —
            debugs the whole Electron app + top-level info, separate from the
            right-panel CDP that inspects the user's mini-program. Always
            rendered: unlike the page-path copy button, it's independent of
            the current page. */}
        <button
          className="ml-auto shrink-0 flex items-center justify-center w-4 h-4 rounded text-text-dim hover:text-text transition-colors"
          onClick={onOpenInternalDevtools}
          title="调试开发者工具"
          data-testid="sim-open-internal-devtools"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <rect
              x="3"
              y="3.5"
              width="5"
              height="5.5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1"
            />
            <path
              d="M4 3.5V3a1.5 1.5 0 013 0v.5M1.5 5.5H3M8 5.5h1.5M2 8.5l1.3-1M9 8.5l-1.3-1M2 3l1.3 1M9 3L7.7 4"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
