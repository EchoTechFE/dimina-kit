export interface WxmlNode {
  tagName: string
  attrs: Record<string, string>
  children: WxmlNode[]
  text?: string
  sid?: string
}
