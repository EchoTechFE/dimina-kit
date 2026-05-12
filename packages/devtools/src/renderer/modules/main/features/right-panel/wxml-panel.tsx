import React, { useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import type { ElementInspection } from '../../../../../shared/ipc-channels'
import type { WxmlNode } from './types.js'

interface WxmlPanelProps {
  tree: WxmlNode | null
  onRefresh: () => void
  onInspectElement?: (sid: string) => Promise<ElementInspection | null>
  onClearInspection?: () => Promise<void>
}

interface WxmlTreeNodeProps {
  node: WxmlNode
  depth: number
  selectedSid?: string | null
  onInspectNode?: (node: WxmlNode) => void
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

function WxmlTreeNode({ node, depth, selectedSid, onInspectNode }: WxmlTreeNodeProps) {
  const [expanded, setExpanded] = useState(() => isDefaultExpanded(node))
  const indent = depth * 16
  const isInspectable = Boolean(node.sid)
  const isSelected = Boolean(node.sid && node.sid === selectedSid)
  const rowClassName = `py-px leading-[18px] hover:bg-surface-2${isInspectable ? ' cursor-pointer' : ''}${isSelected ? ' bg-surface-2' : ''}`
  const inspect = () => {
    if (node.sid) onInspectNode?.(node)
  }

  // Text node — render as plain text
  if (node.tagName === '#text') {
    return (
      <div
        className="py-px leading-[18px] hover:bg-surface-2"
        style={{ paddingLeft: indent }}
      >
        <span className="w-3 inline-block" />
        <span className="text-text">{node.text}</span>
      </div>
    )
  }

  // Fragment — transparent root wrapper; render children directly without extra depth/tag.
  if (node.tagName === '#fragment') {
    return (
      <>
        {(node.children ?? []).map((child, i) => (
          <WxmlTreeNode
            key={i}
            node={child}
            depth={depth}
            selectedSid={selectedSid}
            onInspectNode={onInspectNode}
          />
        ))}
      </>
    )
  }

  // Shadow root — synthetic boundary for custom component internals.
  // Clickable to collapse like WeChat DevTools; default expanded; no closing tag.
  if (node.tagName === '#shadow-root') {
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
            selectedSid={selectedSid}
            onInspectNode={onInspectNode}
          />
        ))}
      </div>
    )
  }

  const hasChildren = (node.children ?? []).length > 0
  const attrEntries = Object.entries(node.attrs) as Array<[string, string]>

  // Single text child — render inline: <tag>text</tag>
  const inlineText = hasChildren && node.children.length === 1 && node.children[0]!.tagName === '#text'
    ? node.children[0]!.text
    : null

  if (inlineText) {
    return (
      <div
        className={rowClassName}
        style={{ paddingLeft: indent }}
        onMouseEnter={inspect}
        onClick={inspect}
      >
        <span className="w-3 inline-block" />
        <span className="text-code-keyword">{'<'}{node.tagName}</span>
        {attrEntries.map(([k, v]) => (
          <span key={k}>
            {' '}
            <span className="text-code-blue">{k}</span>
            <span className="text-text-dim">=</span>
            <span className="text-code-orange">&quot;{v}&quot;</span>
          </span>
        ))}
        <span className="text-code-keyword">{'>'}</span>
        <span className="text-text">{inlineText}</span>
        <span className="text-code-keyword">{'</'}{node.tagName}{'>'}</span>
      </div>
    )
  }

  return (
    <div>
      <div
        className={`flex items-start hover:bg-surface-2 py-px leading-[18px]${hasChildren || isInspectable ? ' cursor-pointer' : ''}${isSelected ? ' bg-surface-2' : ''}`}
        style={{ paddingLeft: indent }}
        onMouseEnter={inspect}
        onClick={() => {
          inspect()
          if (hasChildren) setExpanded(!expanded)
        }}
      >
        <span className="text-text-dim w-3 shrink-0 text-center select-none">
          {hasChildren ? (expanded ? '\u25BE' : '\u25B8') : ' '}
        </span>
        <span>
          <span className="text-code-keyword">{'<'}{node.tagName}</span>
          {attrEntries.map(([k, v]) => (
            <span key={k}>
              {' '}
              <span className="text-code-blue">{k}</span>
              <span className="text-text-dim">=</span>
              <span className="text-code-orange">&quot;{v}&quot;</span>
            </span>
          ))}
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
              selectedSid={selectedSid}
              onInspectNode={onInspectNode}
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

function InspectionFooter({ inspection }: { inspection: ElementInspection | null }) {
  if (!inspection) return null
  const { rect, style } = inspection
  return (
    <div className="border-t border-border-subtle bg-bg-panel px-2.5 py-1.5 font-mono text-[11px] text-text-dim shrink-0">
      <span className="text-text">box</span>
      {' '}
      {Math.round(rect.width)} x {Math.round(rect.height)}
      {' @ '}
      {Math.round(rect.x)}, {Math.round(rect.y)}
      <span className="mx-2 text-border-subtle">|</span>
      {style.display}
      {style.position !== 'static' ? ` / ${style.position}` : ''}
      {style.boxSizing ? ` / ${style.boxSizing}` : ''}
      <span className="mx-2 text-border-subtle">|</span>
      font {style.fontSize}
    </div>
  )
}

export function WxmlPanel({
  tree,
  onRefresh,
  onInspectElement,
  onClearInspection,
}: WxmlPanelProps) {
  const [inspection, setInspection] = useState<ElementInspection | null>(null)

  const inspectNode = (node: WxmlNode) => {
    if (!node.sid || !onInspectElement) return
    void onInspectElement(node.sid).then((next) => {
      setInspection(next)
    })
  }

  const clearInspection = () => {
    setInspection(null)
    void onClearInspection?.()
  }

  if (!tree) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center px-2.5 py-1.5 border-b border-border-subtle shrink-0 bg-bg-panel">
          <Button
            variant="outline"
            size="xs"
            onClick={onRefresh}
            className="hover:border-accent hover:text-accent"
          >
            ↻ 刷新
          </Button>
        </div>
        <div className="text-[12px] text-text-dim text-center px-4 py-6">
          等待小程序加载...
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col flex-1 overflow-hidden" onMouseLeave={clearInspection}>
      <div className="flex items-center px-2.5 py-1.5 border-b border-border-subtle shrink-0 bg-bg-panel">
        <Button
          variant="outline"
          size="xs"
          onClick={onRefresh}
          className="hover:border-accent hover:text-accent"
        >
          ↻ 刷新
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 font-mono text-[12px]">
        <WxmlTreeNode
          node={tree}
          depth={0}
          selectedSid={inspection?.sid}
          onInspectNode={inspectNode}
        />
      </div>
      <InspectionFooter inspection={inspection} />
    </div>
  )
}
