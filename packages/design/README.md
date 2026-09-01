# @dimina-kit/design

dimina-kit 桌面端 UI 的外观层：配色变量、元素基础样式、Tailwind 别名，以及 `@dimina-kit/electron-deck` 那套停靠面板的皮肤。

拿它是为了不用重写一遍。`@dimina-kit/electron-deck` 是刻意无样式的——它渲染的是语义化的 `role="tablist"`、`[data-deck-tab]`、`[data-deck-resize-handle]`，视觉全部交给宿主。不给皮肤的话，标签页会显示成一行裸的大号文字，拖拽分隔条塌成 0 像素、根本抓不住。这个包就是那层皮肤，外加它依赖的整套颜色变量。

## 安装

```sh
pnpm add @dimina-kit/design
```

## 快速上手

**一、引入样式**（应用入口，一次就够）：

```ts
import '@dimina-kit/design/css/index.css'
```

**二、接上 Tailwind 别名**（用到 `bg-surface-2`、`text-code-blue` 这类类名时才需要）：

```js
// tailwind.config.cjs
module.exports = {
  presets: [require('@dimina-kit/design/tailwind-preset')],
  content: ['./src/**/*.{html,ts,tsx}'],
}
```

只引 CSS 不接 preset，变量有了但工具类不会生成；只接 preset 不引 CSS，类名生成了但取到的变量是空的、画出来什么都没有。两个一起用。

**三、拼类名**：

```ts
import { cn } from '@dimina-kit/design'

cn('p-2', props.className)  // 调用方的 p-4 能盖掉默认的 p-2
```

## 里面有什么

`css/index.css` 把下面三份按依赖顺序串起来，也可以单独引：

| 文件 | 内容 | 什么时候单独引 |
| --- | --- | --- |
| `css/tokens.css` | 全部 CSS 变量。自带 `cornetto-tokens.css` | 只要配色，样式自己写 |
| `css/base.css` | `box-sizing`、`html/body` 的字体和底色、滚动条、`role="separator"` 的焦点框抑制、`pulse` 动画 | 想要基础样式但不要 deck 皮肤 |
| `css/deck.css` | electron-deck 的标签页、关闭按钮、拖拽分隔条 | 只用 dock，配色自己定（那就得自己补它读的那些变量） |

这些文件就真的躺在包里的 `css/` 目录下，路径和你写的 `@import` 一模一样。Vite 会读 `exports` 字段，但 webpack、Tailwind CLI 和普通 PostCSS 用的 `postcss-import` 不读，它只按字面路径去 `node_modules/@dimina-kit/design/css/` 找文件——所以这个目录不能挪。

`base.css` 不给页面定高度——`height: 100vh` / `overflow: hidden` 是应用外壳的决定，不是设计的决定，所以滚动式文档也能正常用。桌面应用需要固定视口的话，自己写这两行。

## 深色和浅色

底层色板是 Cornetto（`css/cornetto-tokens.css`，自动生成，别手改）。它默认浅色，深色靠给 `<html>` 加 `.dark` 类。

`tokens.css` 改成了跟随系统：深色是默认值，`prefers-color-scheme: light` 时再复原成浅色。想要类名切换的话，只引 `cornetto-tokens.css`，别引 `tokens.css`。

## 换配色

改 `--qd-*` 那批语义变量就行，在你自己的样式里覆盖：

```css
:root {
  --qd-primary: #0a84ff;
}
```

上层的 `--color-accent`、`--color-ring`、按钮和标签页的高亮都是从它派生的，会一起变。不要去改 `--color-*`，那层是别名。

## 不包含什么

React 组件（Button、Dialog 这些）目前还在 `packages/devtools` 里，没搬过来。要它们的话现在只能自己按 tokens 写，或者直接从 Cornetto 的 registry 拉。
