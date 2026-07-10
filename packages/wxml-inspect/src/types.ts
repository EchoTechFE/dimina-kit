// Wire-format types shared by every host that extracts or displays a WXML
// tree (Electron devtools, browser workbench panels, downstream hosts). They
// are the protocol layer: hosts may transport them over IPC, postMessage or
// any other channel, but the shapes themselves stay host-agnostic.

export interface WxmlNode {
  tagName: string
  attrs: Record<string, string>
  children: WxmlNode[]
  text?: string
  sid?: string
}

/** Measurement of one element (by sid): bounding rect + the computed-style
 * subset the panel footer displays. Producing it must not mutate the page —
 * any visual highlight is the host's concern. */
export interface ElementInspection {
  sid: string
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
  style: {
    display: string
    position: string
    boxSizing: string
    margin: string
    padding: string
    color: string
    backgroundColor: string
    fontSize: string
  }
}
