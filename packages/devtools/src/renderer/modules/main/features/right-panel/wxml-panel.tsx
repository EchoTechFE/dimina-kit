import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ElementInspection } from '../../../../../shared/ipc-channels'
import type { WxmlNode } from './types.js'

interface WxmlPanelProps {
  tree: WxmlNode | null
  onInspectElement?: (sid: string) => Promise<ElementInspection | null>
  onClearInspection?: () => Promise<void>
}

interface WxmlTreeNodeProps {
  node: WxmlNode
  depth: number
  inspectedSid?: string | null
  onInspect?: (node: WxmlNode) => void
}

/**
 * 默认是否展开：对齐微信开发者工具的 wxml 面板。
 * - `#shadow-root` 永远默认展开（组件边界标记，展开后才能看到内部结构）
 * - 路径式 tag（含 `/`）= 页面或自定义组件，默认展开（让用户一眼看清组件层级）
 * - 普通 DOM 节点（view/text 等）默认折叠，需要用户手动点开
 */
function isDefaultExpanded(node: WxmlNode): boolean {
  if (node.tagName === '#shadow-root') return true
  if (node.tagName.includes('/')) return true
  return false
}

/** Renders a `[key, value]` attr list as `{' '}key="value"` pairs. */
function AttrList({ entries }: { entries: Array<[string, string]> }) {
  return (
    <>
      {entries.map(([k, v]) => (
        <span key={k}>
          {' '}
          <span className="text-code-blue">{k}</span>
          <span className="text-text-dim">=</span>
          <span className="text-code-orange">&quot;{v}&quot;</span>
        </span>
      ))}
    </>
  )
}

// Text node — render as plain text.
function WxmlTextNode({ node, depth }: { node: WxmlNode, depth: number }) {
  return (
    <div
      className="py-px leading-[18px] hover:bg-surface-2"
      style={{ paddingLeft: depth * 16 }}
    >
      <span className="w-3 inline-block" />
      <span className="text-text">{node.text}</span>
    </div>
  )
}

// Fragment — transparent root wrapper; render children directly without extra depth/tag.
function WxmlFragmentNode({ node, depth, inspectedSid, onInspect }: WxmlTreeNodeProps) {
  return (
    <>
      {(node.children ?? []).map((child, i) => (
        <WxmlTreeNode
          key={i}
          node={child}
          depth={depth}
          inspectedSid={inspectedSid}
          onInspect={onInspect}
        />
      ))}
    </>
  )
}

// Shadow root — synthetic boundary for custom component internals.
// Clickable to collapse like WeChat DevTools; default expanded; no closing tag.
function WxmlShadowRootNode({ node, depth, inspectedSid, onInspect }: WxmlTreeNodeProps) {
  const [expanded, setExpanded] = useState(() => isDefaultExpanded(node))
  const indent = depth * 16
  const hasShadowChildren = (node.children ?? []).length > 0
  return (
    <div>
      <div
        className="py-px leading-[18px] hover:bg-surface-2 cursor-pointer"
        style={{ paddingLeft: indent }}
        onClick={() => hasShadowChildren && setExpanded(!expanded)}
      >
        <span className="text-text-dim w-3 shrink-0 inline-block text-center select-none">
          {hasShadowChildren ? (expanded ? '▾' : '▸') : ' '}
        </span>
        <span className="text-text-dim italic">#shadow-root</span>
      </div>
      {expanded && node.children.map((child, i) => (
        <WxmlTreeNode
          key={i}
          node={child}
          depth={depth + 1}
          inspectedSid={inspectedSid}
          onInspect={onInspect}
        />
      ))}
    </div>
  )
}

interface WxmlRowProps {
  node: WxmlNode
  indent: number
  attrEntries: Array<[string, string]>
  isInspected: boolean
  onMouseEnter: () => void
}

// Single text child — render inline: <tag>text</tag>
function WxmlInlineTextRow({
  node,
  indent,
  attrEntries,
  isInspected,
  onMouseEnter,
  inlineText,
}: WxmlRowProps & { inlineText: string }) {
  const rowClassName = `py-px leading-[18px] hover:bg-surface-2${isInspected ? ' bg-surface-2' : ''}`
  return (
    <div
      className={rowClassName}
      style={{ paddingLeft: indent }}
      onMouseEnter={onMouseEnter}
      data-wxml-sid={node.sid}
    >
      <span className="w-3 inline-block" />
      <span className="text-code-keyword">{'<'}{node.tagName}</span>
      <AttrList entries={attrEntries} />
      <span className="text-code-keyword">{'>'}</span>
      <span className="text-text">{inlineText}</span>
      <span className="text-code-keyword">{'</'}{node.tagName}{'>'}</span>
    </div>
  )
}

interface WxmlBlockRowProps extends WxmlRowProps {
  depth: number
  hasChildren: boolean
  expanded: boolean
  inspectedSid?: string | null
  onInspect?: (node: WxmlNode) => void
  onToggle: () => void
}

// Full open/close-tag row, with children rendered underneath when expanded.
function WxmlBlockRow({
  node,
  depth,
  indent,
  attrEntries,
  hasChildren,
  expanded,
  isInspected,
  inspectedSid,
  onInspect,
  onToggle,
  onMouseEnter,
}: WxmlBlockRowProps) {
  return (
    <div>
      <div
        className={`flex items-start hover:bg-surface-2 py-px leading-[18px]${hasChildren ? ' cursor-pointer' : ''}${isInspected ? ' bg-surface-2' : ''}`}
        style={{ paddingLeft: indent }}
        onMouseEnter={onMouseEnter}
        onClick={() => {
          if (hasChildren) onToggle()
        }}
        data-wxml-sid={node.sid}
      >
        <span className="text-text-dim w-3 shrink-0 text-center select-none">
          {hasChildren ? (expanded ? '▾' : '▸') : ' '}
        </span>
        <span>
          <span className="text-code-keyword">{'<'}{node.tagName}</span>
          <AttrList entries={attrEntries} />
          <span className="text-code-keyword">{hasChildren ? '>' : ' />'}</span>
        </span>
      </div>
      {expanded && hasChildren && (
        <>
          {node.children.map((child, i) => (
            <WxmlTreeNode
              key={i}
              node={child}
              depth={depth + 1}
              inspectedSid={inspectedSid}
              onInspect={onInspect}
            />
          ))}
          <div style={{ paddingLeft: indent }} className="py-px leading-[18px]">
            <span className="w-3 inline-block" />
            <span className="text-code-keyword">{'</'}{node.tagName}{'>'}</span>
          </div>
        </>
      )}
    </div>
  )
}

// Ordinary element node — decides between the inline-text and block layouts.
function WxmlElementNode({ node, depth, inspectedSid, onInspect }: WxmlTreeNodeProps) {
  const [expanded, setExpanded] = useState(() => isDefaultExpanded(node))
  const indent = depth * 16
  const isInspected = Boolean(node.sid && node.sid === inspectedSid)
  const hasChildren = (node.children ?? []).length > 0
  const attrEntries = Object.entries(node.attrs) as Array<[string, string]>
  const inspect = () => {
    if (node.sid) onInspect?.(node)
  }

  // Single text child — render inline: <tag>text</tag>
  const inlineText = hasChildren && node.children.length === 1 && node.children[0]!.tagName === '#text'
    ? node.children[0]!.text
    : null

  if (inlineText) {
    return (
      <WxmlInlineTextRow
        node={node}
        indent={indent}
        attrEntries={attrEntries}
        isInspected={isInspected}
        onMouseEnter={inspect}
        inlineText={inlineText}
      />
    )
  }

  return (
    <WxmlBlockRow
      node={node}
      depth={depth}
      indent={indent}
      attrEntries={attrEntries}
      hasChildren={hasChildren}
      expanded={expanded}
      isInspected={isInspected}
      inspectedSid={inspectedSid}
      onInspect={onInspect}
      onToggle={() => setExpanded(!expanded)}
      onMouseEnter={inspect}
    />
  )
}

function WxmlTreeNode({ node, depth, inspectedSid, onInspect }: WxmlTreeNodeProps) {
  if (node.tagName === '#text') return <WxmlTextNode node={node} depth={depth} />
  if (node.tagName === '#fragment') {
    return <WxmlFragmentNode node={node} depth={depth} inspectedSid={inspectedSid} onInspect={onInspect} />
  }
  if (node.tagName === '#shadow-root') {
    return <WxmlShadowRootNode node={node} depth={depth} inspectedSid={inspectedSid} onInspect={onInspect} />
  }
  return <WxmlElementNode node={node} depth={depth} inspectedSid={inspectedSid} onInspect={onInspect} />
}

function InspectionFooter({ inspection }: { inspection: ElementInspection | null }) {
  if (!inspection) return null
  const { rect, style } = inspection
  const styleParts = [
    style.display,
    style.position !== 'static' ? style.position : null,
    style.boxSizing,
  ].filter(Boolean)
  return (
    <div className="border-t border-border-subtle bg-bg-panel px-2.5 py-1.5 font-mono text-[11px] text-text-dim shrink-0">
      <span className="text-text">box</span>
      {' '}
      {Math.round(rect.width)} x {Math.round(rect.height)}
      {' @ '}
      {Math.round(rect.x)}, {Math.round(rect.y)}
      <span className="mx-2 text-border-subtle">|</span>
      {styleParts.join(' / ')}
      <span className="mx-2 text-border-subtle">|</span>
      font {style.fontSize}
    </div>
  )
}

export function WxmlPanel({
  tree,
  onInspectElement,
  onClearInspection,
}: WxmlPanelProps) {
  const [inspection, setInspection] = useState<ElementInspection | null>(null)
  // 序号 + rAF 用于解决 hover 触发的两个独立问题：
  // - reqSeqRef：防止 await 完成顺序与 hover 顺序不一致导致 footer 抖动；
  //   每次发起请求自增，写入前比对，落后的响应直接丢弃。
  // - rafRef：把 hover 触发的 IPC 合并到下一帧，连续扫过列表只会留最后一帧。
  const reqSeqRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

  const inspectNode = useCallback((node: WxmlNode) => {
    if (!node.sid || !onInspectElement) return
    const sid = node.sid
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const seq = ++reqSeqRef.current
      onInspectElement(sid).then((next) => {
        if (seq !== reqSeqRef.current) return
        setInspection(next)
      }).catch(() => {
        if (seq !== reqSeqRef.current) return
        setInspection(null)
      })
    })
  }, [onInspectElement])

  const clearInspection = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    // 让所有 in-flight 响应被序号校验丢弃，避免它们在 clear 之后又把 inspection 写回来。
    reqSeqRef.current++
    setInspection(null)
    void onClearInspection?.()
  }, [onClearInspection])

  if (!tree) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden" data-testid="wxml-panel">
        <div className="text-[12px] text-text-dim text-center px-4 py-6">
          等待小程序加载...
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col flex-1 overflow-hidden" onMouseLeave={clearInspection} data-testid="wxml-panel">
      <div className="flex-1 overflow-y-auto p-2 font-mono text-[12px]">
        <WxmlTreeNode
          node={tree}
          depth={0}
          inspectedSid={inspection?.sid ?? null}
          onInspect={inspectNode}
        />
      </div>
      <InspectionFooter inspection={inspection} />
    </div>
  )
}
