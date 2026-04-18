import React, { useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import type { WxmlNode } from './types.js'

function WxmlTreeNode({ node, depth }: { node: WxmlNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 3)
  const indent = depth * 16

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
          <WxmlTreeNode key={i} node={child} depth={depth} />
        ))}
      </>
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
        className="py-px leading-[18px] hover:bg-surface-2"
        style={{ paddingLeft: indent }}
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
        className="flex items-start hover:bg-surface-2 cursor-pointer py-px leading-[18px]"
        style={{ paddingLeft: indent }}
        onClick={() => hasChildren && setExpanded(!expanded)}
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
            <WxmlTreeNode key={i} node={child} depth={depth + 1} />
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

export function WxmlPanel({ tree, onRefresh }: { tree: WxmlNode | null; onRefresh: () => void }) {
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
      <div className="flex-1 overflow-y-auto p-2 font-mono text-[12px]">
        <WxmlTreeNode node={tree} depth={0} />
      </div>
    </div>
  )
}
