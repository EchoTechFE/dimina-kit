import { describe, expect, it } from "vitest";
import {
  computeResizePayload,
  NAV_BAR_HEIGHT,
  OrientationController,
  pageWindowSize,
  tabBarReservedHeight,
  TAB_BAR_HEIGHT,
} from "./orientation-controller";

// Notch-free: its safe-area insets are 0 in either orientation, so cases that are not about insets read the same numbers whichever way the page faces.
const PORTRAIT_DEVICE = {
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 47,
  notchType: "none",
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};

// iPhone X profile: portrait home indicator 34, landscape 21.
const NOTCHED_DEVICE = {
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 44,
  notchType: "notch",
  safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
};

/**
 * A host report.
 * These gating tests only vary the window size — the screen dimensions ride along in `size` for the business callbacks and never enter the dispatch verdict.
 */
function report(windowWidth: number, windowHeight: number) {
  return { screenWidth: windowWidth, screenHeight: windowHeight + NAV_BAR_HEIGHT, windowWidth, windowHeight };
}

describe("OrientationController", () => {
  describe("openPage / closePage", () => {
    it("resolves state from the page config", () => {
      const ctrl = new OrientationController();
      expect(ctrl.openPage("a", "landscape")).toEqual({
        originalPageOrientation: "landscape",
      });
    });

    it("is idempotent for an already-known bridgeId", () => {
      const ctrl = new OrientationController();
      const first = ctrl.openPage("a", "auto");
      expect(ctrl.openPage("a", "auto")).toBe(first);
    });

    it("releases tracked state", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "auto");
      ctrl.buildResizePayload("s1", "a", "portrait", report(390, 700));
      ctrl.closePage("a");
      expect(ctrl.getState("a")).toBeUndefined();
      expect(() =>
        ctrl.buildResizePayload("s1", "a", "portrait", report(390, 700)),
      ).toThrow(/unknown bridgeId/);
    });

    it("lists every tracked bridgeId", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "auto");
      ctrl.openPage("b", "landscape");
      expect(Array.from(ctrl.knownBridgeIds()).sort()).toEqual(["a", "b"]);
    });
  });

  describe("effectiveFor", () => {
    it("an auto page follows the device orientation", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "auto");
      expect(ctrl.effectiveFor("a", "portrait")).toBe("portrait");
      expect(ctrl.effectiveFor("a", "landscape")).toBe("landscape");
    });

    it("a fixed-orientation page ignores the device orientation", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "landscape");
      expect(ctrl.effectiveFor("a", "portrait")).toBe("landscape");
      expect(ctrl.effectiveFor("a", "landscape")).toBe("landscape");
    });

    it("falls back to the device orientation for an unregistered page", () => {
      const ctrl = new OrientationController();
      expect(ctrl.effectiveFor("ghost", "landscape")).toBe("landscape");
    });

  });

  describe("buildResizePayload", () => {
    it("throws for an unregistered bridgeId", () => {
      const ctrl = new OrientationController();
      expect(() =>
        ctrl.buildResizePayload("s1", "ghost", "portrait", report(1, 1)),
      ).toThrow(/unknown bridgeId/);
    });

    it("dispatches both channels on the first frame of a fresh app lifetime", () => {
      // The app-global baseline starts empty, so the first geometry of a lifetime is a change for the window channel too.
      const ctrl = new OrientationController();
      ctrl.openPage("a", "auto");
      const payload = ctrl.buildResizePayload("s1", "a", "portrait", report(390, 700));
      expect(payload).toMatchObject({
        appSessionId: "s1",
        bridgeId: "a",
        deviceOrientation: "portrait",
        dispatchWindow: true,
        dispatchPage: true,
        canRotate: true,
      });
    });

    it("keeps the page channel open when a report repeats the geometry, and closes only the window channel", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "auto");
      ctrl.buildResizePayload("s1", "a", "portrait", report(390, 700));
      const second = ctrl.buildResizePayload("s1", "a", "landscape", report(844, 320));
      expect(second.dispatchWindow).toBe(true);
      expect(second.dispatchPage).toBe(true);
      expect(second.deviceOrientation).toBe("landscape");
      // Same geometry again: the app-global baseline did not move, so the window channel closes.
      // The page channel carries whichever page is being reported regardless of geometry.
      const third = ctrl.buildResizePayload("s1", "a", "landscape", report(844, 320));
      expect(third.dispatchWindow).toBe(false);
      expect(third.dispatchPage).toBe(true);
    });

    it("gives a cached page returning to a geometry another page already reported its own Page.onResize", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "auto");
      ctrl.openPage("b", "auto");
      const portrait = report(390, 700);
      const landscape = report(844, 320);
      ctrl.buildResizePayload("s1", "a", "portrait", portrait);
      // "b" rotates the window to landscape while "a" stays cached in portrait.
      ctrl.buildResizePayload("s1", "b", "portrait", portrait);
      ctrl.buildResizePayload("s1", "b", "landscape", landscape);
      const back = ctrl.buildResizePayload("s1", "a", "landscape", landscape);
      // The window has not moved since "b" reported it, so only the page that is now on screen hears about it.
      expect(back.dispatchWindow).toBe(false);
      expect(back.dispatchPage).toBe(true);
    });

    it("stays silent on both channels for a page pinned to a fixed orientation", () => {
      const ctrl = new OrientationController();
      ctrl.openPage("a", "landscape");
      const first = ctrl.buildResizePayload("s1", "a", "portrait", report(844, 320));
      expect(first.dispatchWindow).toBe(false);
      expect(first.dispatchPage).toBe(false);
      expect(first.canRotate).toBe(false);
    });
  });
});

describe("tabBarReservedHeight", () => {
  it("adds the content-box row height, the bottom safe-area padding, and the 1px border-top", () => {
    // tab-bar.css: box-sizing:content-box + border-top:1px; tab-bar.tsx: inline padding-bottom = bottomInset.
    // A home-button device has bottomInset 0.
    expect(tabBarReservedHeight(0)).toBe(TAB_BAR_HEIGHT + 1);
    expect(tabBarReservedHeight(34)).toBe(TAB_BAR_HEIGHT + 34 + 1);
  });
});

describe("pageWindowSize", () => {
  const oriented = { screenWidth: 390, screenHeight: 844, statusBarHeight: 47 };

  it("subtracts the status bar and nav bar for a default non-tab page", () => {
    expect(
      pageWindowSize(oriented, {
        navigationStyle: "default",
        isTab: false,
        bottomInset: 0,
      }),
    ).toEqual({
      windowWidth: 390,
      windowHeight: 844 - 47 - NAV_BAR_HEIGHT,
    });
  });

  it("subtracts the REAL tab-bar-reserved height (row + bottom inset + border), not just the 50px row", () => {
    expect(
      pageWindowSize(oriented, {
        navigationStyle: "default",
        isTab: true,
        bottomInset: 34,
      }),
    ).toEqual({
      windowWidth: 390,
      windowHeight: 844 - 47 - NAV_BAR_HEIGHT - tabBarReservedHeight(34),
    });
  });

  it("navigationStyle: custom reserves NEITHER the status bar NOR the nav bar — both are position:absolute overlays (status-bar.css always; navigation-bar.css .nav-bar--custom)", () => {
    expect(
      pageWindowSize(oriented, {
        navigationStyle: "custom",
        isTab: false,
        bottomInset: 0,
      }),
    ).toEqual({
      windowWidth: 390,
      windowHeight: 844,
    });
  });

  it("a custom-nav tabBar page still reserves the real tab bar height", () => {
    expect(
      pageWindowSize(oriented, {
        navigationStyle: "custom",
        isTab: true,
        bottomInset: 34,
      }),
    ).toEqual({
      windowWidth: 390,
      windowHeight: 844 - tabBarReservedHeight(34),
    });
  });

  it("never returns a negative height", () => {
    const tiny = { screenWidth: 100, screenHeight: 50, statusBarHeight: 47 };
    expect(
      pageWindowSize(tiny, {
        navigationStyle: "default",
        isTab: true,
        bottomInset: 34,
      }).windowHeight,
    ).toBe(0);
  });
});

describe("computeResizePayload", () => {
  it("swaps dimensions and drops the status bar for a landscape auto page", () => {
    const ctrl = new OrientationController();
    ctrl.openPage("a", "auto");
    const payload = computeResizePayload(
      ctrl,
      "s1",
      { bridgeId: "a", reservesTabBar: false, navBarStyle: "default" },
      PORTRAIT_DEVICE,
      "landscape",
    );
    expect(payload.deviceOrientation).toBe("landscape");
    // Both pairs swap together, and the screen keeps the chrome the window gives up — that difference is the whole reason a host reports both.
    expect(payload.size).toEqual({
      screenWidth: 844,
      screenHeight: 390,
      windowWidth: 844,
      windowHeight: 390 - NAV_BAR_HEIGHT,
    });
    expect(payload.canRotate).toBe(true);
  });

  it("keeps a fixed-orientation page silent on its first frame even though it visibly differs from the device", () => {
    const ctrl = new OrientationController();
    ctrl.openPage("a", "landscape");
    const payload = computeResizePayload(
      ctrl,
      "s1",
      { bridgeId: "a", reservesTabBar: true, navBarStyle: "default" },
      NOTCHED_DEVICE,
      "portrait",
    );
    expect(payload.deviceOrientation).toBe("landscape");
    expect(payload.dispatchWindow).toBe(false);
    expect(payload.dispatchPage).toBe(false);
    expect(payload.canRotate).toBe(false);
    // The page is displayed landscape even though the device is portrait, so it reserves the LANDSCAPE home indicator (21), not the device's 34.
    expect(payload.size).toEqual({
      // The screen follows the orientation the page SHOWS, not the device's own.
      screenWidth: 844,
      screenHeight: 390,
      windowWidth: 844,
      windowHeight: 390 - NAV_BAR_HEIGHT - tabBarReservedHeight(21),
    });
  });

  it("shares the geometry baseline across bridgeIds: the same geometry reported for a different page is not a change", () => {
    const ctrl = new OrientationController();
    ctrl.openPage("a", "auto");
    ctrl.openPage("b", "auto");

    const first = computeResizePayload(
      ctrl,
      "s1",
      { bridgeId: "a", reservesTabBar: false, navBarStyle: "default" },
      PORTRAIT_DEVICE,
      "landscape",
    );
    expect(first.dispatchWindow).toBe(true);

    const second = computeResizePayload(
      ctrl,
      "s1",
      { bridgeId: "b", reservesTabBar: false, navBarStyle: "default" },
      PORTRAIT_DEVICE,
      "landscape",
    );
    expect(second.dispatchWindow).toBe(false);
    // The page channel is not baseline-driven: it carries whichever page is being reported, so "b" still gets its own Page.onResize.
    expect(second.dispatchPage).toBe(true);
  });


  it("silences only the window channel when the same geometry is recomputed for an auto page", () => {
    const ctrl = new OrientationController();
    ctrl.openPage("a", "auto");

    const first = computeResizePayload(
      ctrl,
      "s1",
      { bridgeId: "a", reservesTabBar: false, navBarStyle: "default" },
      PORTRAIT_DEVICE,
      "landscape",
    );
    expect(first.dispatchWindow).toBe(true);
    expect(first.dispatchPage).toBe(true);

    const second = computeResizePayload(
      ctrl,
      "s1",
      { bridgeId: "a", reservesTabBar: false, navBarStyle: "default" },
      PORTRAIT_DEVICE,
      "landscape",
    );
    expect(second.dispatchWindow).toBe(false);
    expect(second.dispatchPage).toBe(true);
  });

  it("reserves the tab bar at the page's own effective orientation's inset, not the device's portrait baseline", () => {
    const ctrl = new OrientationController();
    ctrl.openPage("a", "auto");
    const target = {
      bridgeId: "a",
      reservesTabBar: true,
      navBarStyle: "default" as const,
    };

    const portrait = computeResizePayload(
      ctrl,
      "s1",
      target,
      NOTCHED_DEVICE,
      "portrait",
    );
    expect(portrait.size.windowHeight).toBe(
      844 - 44 - NAV_BAR_HEIGHT - tabBarReservedHeight(34),
    );

    // The landscape home indicator is thinner (21), so the tab bar gives 13px back — the same number the spawn seed derives from the oriented host env.
    const landscape = computeResizePayload(
      ctrl,
      "s1",
      target,
      NOTCHED_DEVICE,
      "landscape",
    );
    expect(landscape.size.windowHeight).toBe(
      390 - NAV_BAR_HEIGHT - tabBarReservedHeight(21),
    );
  });
});
