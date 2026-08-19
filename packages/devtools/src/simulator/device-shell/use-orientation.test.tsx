/**
 * `useOrientation` — the shell-side landing of every geometry trigger.
 *
 * Guards these invariants:
 *  - the top page is registered before its geometry is read, so the metrics the
 * shell renders at describe the page that is actually on top even on the very first render that receives it;
 *  - `publishTopResize` lets a synchronous route publish the incoming page's
 *    geometry ahead of the lifecycle events it dispatches;
 *  - the reported window height follows the tab bar's VISIBILITY, not merely
 * the page's tab-route flag, because `wx.hideTabBar` hands its reserved height back to the page.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  NAV_BAR_HEIGHT,
  tabBarReservedHeight,
} from "@dimina-kit/electron-runtime/shared/page-orientation";
import type {
  PageOrientationConfig,
  PageResizePayload,
} from "@dimina-kit/electron-runtime/shared/page-orientation";
import type { NativeDeviceInfo } from "../../shared/ipc-channels";
import type {
  MountedEntry,
  PageEntry,
} from "@dimina-kit/electron-runtime/simulator-ui";
import { useOrientation } from "./use-orientation";

const DEVICE: NativeDeviceInfo = {
  brand: "Apple",
  model: "iPhone 14",
  system: "iOS 16.0",
  platform: "ios",
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 47,
  notchType: "dynamic-island",
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
  deviceOrientation: "portrait",
};

function page(
  bridgeId: string,
  isTab: boolean,
  pageOrientation: PageOrientationConfig = "auto",
): PageEntry {
  return {
    bridgeId,
    pagePath: `pages/${bridgeId}/${bridgeId}`,
    query: {},
    isTab,
    windowConfig: { pageOrientation },
    navBar: {
      title: bridgeId,
      style: "default",
      backgroundColor: "#ffffff",
      textStyle: "black",
      loading: false,
      homeButtonVisible: false,
    },
  };
}

interface Harness {
  miniApp: {
    appSessionId: string;
    notifyResize: ReturnType<typeof vi.fn>;
  };
  resizes: () => PageResizePayload[];
}

function makeHarness(): Harness {
  const notifyResize = vi.fn();
  const miniApp = {
    appSessionId: "s1",
    notifyResize,
  };
  return {
    miniApp,
    resizes: () =>
      notifyResize.mock.calls.map((c) => c[0] as PageResizePayload),
  };
}

function mount(h: Harness, entries: PageEntry[], tabBarVisible: boolean) {
  const mounted: MountedEntry[] = entries.map((entry, i) => ({
    entry,
    visible: i === entries.length - 1,
  }));
  const top = entries[entries.length - 1]!;
  return renderHook(
    (props: {
      mounted: MountedEntry[];
      top: PageEntry;
      tabBarVisible: boolean;
    }) =>
      useOrientation(
        h.miniApp as never,
        {
          top: props.top,
          mounted: props.mounted,
          tabBarVisible: props.tabBarVisible,
        },
        DEVICE,
      ),
    { initialProps: { mounted, top, tabBarVisible } },
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("useOrientation: the top page is registered before it is measured", () => {
  it("a routed-in fixed-orientation page sizes the shell on the render that receives it", () => {
    const h = makeHarness();
    const tabPage = page("a", true);
    const detail = page("b", false, "landscape");
    const { result, rerender } = mount(h, [tabPage], true);

    expect(result.current.orientedMetrics).toEqual({
      screenWidth: 390,
      screenHeight: 844,
      statusBarHeight: 47,
    });

    rerender({
      mounted: [
        { entry: tabPage, visible: false },
        { entry: detail, visible: true },
      ],
      top: detail,
      tabBarVisible: true,
    });

    expect(
      result.current.orientedMetrics,
      "nothing re-renders the shell after the layout effect, so the render itself must already know the page",
    ).toEqual({ screenWidth: 844, screenHeight: 390, statusBarHeight: 0 });
  });
});

describe("useOrientation: publishTopResize", () => {
  it("reports the given page as the visible top at its own effective orientation", () => {
    const h = makeHarness();
    const detail = page("b", false, "landscape");
    const { result } = mount(h, [page("a", true)], true);
    h.miniApp.notifyResize.mockClear();

    act(() => result.current.publishTopResize(detail));

    const payload = h.resizes().at(-1)!;
    expect(payload.bridgeId).toBe("b");
    expect(payload.deviceOrientation).toBe("landscape");
    expect(payload.size).toEqual({
      screenWidth: 844,
      screenHeight: 390,
      windowWidth: 844,
      windowHeight: 390 - NAV_BAR_HEIGHT,
    });
  });

  it("reports a restored tab page with the tab bar it reserves again", () => {
    const h = makeHarness();
    const tabPage = page("a", true);
    const { result } = mount(h, [tabPage], true);
    h.miniApp.notifyResize.mockClear();

    act(() => result.current.publishTopResize(tabPage));

    const payload = h.resizes().at(-1)!;
    expect(payload.deviceOrientation).toBe("portrait");
    expect(payload.size.windowHeight).toBe(
      844 - 47 - NAV_BAR_HEIGHT - tabBarReservedHeight(34),
    );
    expect(
      payload.dispatchWindow,
      "republishing an unchanged geometry must not fire another wx.onWindowResize",
    ).toBe(false);
    expect(
      payload.dispatchPage,
      "the page channel still carries the restored page, which is how it re-reads the window it came back into",
    ).toBe(true);
  });
});

describe("useOrientation: only a changed window republishes from the layout effect", () => {
  it("a layout state rebuilt for a navigation-bar change publishes nothing", () => {
    // A report refreshes main's host-env snapshot and re-emits the session orientation, so republishing behind every `setNavigationBarTitle` would make the route geometry no longer have a single publisher.
    const h = makeHarness();
    const first = page("a", false);
    const { rerender } = mount(h, [first], false);
    const before = h.resizes().length;
    expect(before).toBeGreaterThan(0);

    const renamed: PageEntry = {
      ...first,
      navBar: { ...first.navBar, title: "a new title", loading: true },
    };
    rerender({
      mounted: [{ entry: renamed, visible: true }],
      top: renamed,
      tabBarVisible: false,
    });

    expect(h.resizes().length).toBe(before);
  });

  it("a route commit onto the same page still reports, with the window channel silent", () => {
    // The report itself is what refreshes main's host-env snapshot and the session orientation, so it goes out on every route commit.
    // The window channel is baseline-driven and nothing moved; the page channel carries the committed page regardless.
    const h = makeHarness();
    const only = page("a", false);
    const { result } = mount(h, [only], false);
    const before = h.resizes().length;

    act(() => result.current.publishTopResize(only));

    expect(h.resizes().length).toBe(before + 1);
    expect(h.resizes().at(-1)!.dispatchPage).toBe(true);
    expect(h.resizes().at(-1)!.dispatchWindow).toBe(false);
  });
});

describe("useOrientation: tab bar visibility drives the reported window height", () => {
  it("hiding the tab bar hands its reserved height back to the page", () => {
    const h = makeHarness();
    const tabPage = page("a", true);
    const { rerender } = mount(h, [tabPage], true);

    const withBar = h.resizes().at(-1)!;
    expect(withBar.size.windowHeight).toBe(
      844 - 47 - NAV_BAR_HEIGHT - tabBarReservedHeight(34),
    );

    rerender({
      mounted: [{ entry: tabPage, visible: true }],
      top: tabPage,
      tabBarVisible: false,
    });

    const withoutBar = h.resizes().at(-1)!;
    expect(withoutBar.size.windowHeight).toBe(844 - 47 - NAV_BAR_HEIGHT);
    expect(withoutBar.dispatchWindow).toBe(true);
    expect(withoutBar.dispatchPage).toBe(true);
  });

  it("a non-tab page is unaffected by the tab bar flag", () => {
    const h = makeHarness();
    const plain = page("a", false);
    const { rerender } = mount(h, [plain], true);
    const before = h.resizes().at(-1)!.size.windowHeight;

    rerender({
      mounted: [{ entry: plain, visible: true }],
      top: plain,
      tabBarVisible: false,
    });

    expect(h.resizes().at(-1)!.size.windowHeight).toBe(before);
  });
});

