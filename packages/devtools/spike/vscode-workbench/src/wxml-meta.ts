/**
 * WXML tag / attribute / directive metadata, shaped for
 * vscode-html-languageservice's `IHTMLDataProvider` (customData).
 *
 * Source of truth mirrored from the devtools renderer's hand-authored tables
 * (packages/devtools/src/renderer/.../monaco-editor/language/wxml-data.ts).
 * Kept self-contained here so the spike bundle has no cross-tsconfig import
 * into the renderer. Only the common, stable components are covered.
 */
import type { IHTMLDataProvider, HTMLDataV1 } from 'vscode-html-languageservice'
import { newHTMLDataProvider } from 'vscode-html-languageservice'

interface Attr {
  name: string
  description?: string
  values?: string[]
}
interface Tag {
  name: string
  description: string
  attrs?: Attr[]
}

const TAGS: Tag[] = [
  { name: 'view', description: '视图容器，最基础的块级容器，类似 div。', attrs: [
    { name: 'hover-class', description: '指定按下去的样式类，none 表示无效果' },
    { name: 'hover-stop-propagation', description: '阻止本节点的祖先节点出现点击态' },
    { name: 'hover-start-time', description: '按住后多久出现点击态，单位 ms' },
    { name: 'hover-stay-time', description: '手指松开后点击态保留时间，单位 ms' },
  ] },
  { name: 'scroll-view', description: '可滚动视图区域，支持横/纵向滚动、下拉刷新。', attrs: [
    { name: 'scroll-x', description: '允许横向滚动', values: ['true', 'false'] },
    { name: 'scroll-y', description: '允许纵向滚动', values: ['true', 'false'] },
    { name: 'scroll-into-view', description: '滚动到指定子元素，传 id' },
    { name: 'scroll-top', description: '设置竖向滚动条位置' },
    { name: 'scroll-left', description: '设置横向滚动条位置' },
    { name: 'scroll-with-animation', description: '滚动时使用动画过渡', values: ['true', 'false'] },
    { name: 'upper-threshold', description: '距顶部多远触发 scrolltoupper，单位 px' },
    { name: 'lower-threshold', description: '距底部多远触发 scrolltolower，单位 px' },
    { name: 'enable-back-to-top', description: '点击顶部状态栏滚动到顶部', values: ['true', 'false'] },
    { name: 'enable-flex', description: '让 flex 布局生效', values: ['true', 'false'] },
    { name: 'refresher-enabled', description: '开启自定义下拉刷新', values: ['true', 'false'] },
    { name: 'refresher-triggered', description: '设置当前下拉刷新状态', values: ['true', 'false'] },
    { name: 'paging-enabled', description: '分页滑动效果', values: ['true', 'false'] },
    { name: 'bindscroll', description: '滚动时触发' },
    { name: 'bindscrolltoupper', description: '滚动到顶部/左边触发' },
    { name: 'bindscrolltolower', description: '滚动到底部/右边触发' },
    { name: 'bindrefresherrefresh', description: '自定义下拉刷新被触发' },
  ] },
  { name: 'swiper', description: '滑块视图容器，子元素必须为 swiper-item。', attrs: [
    { name: 'indicator-dots', description: '是否显示面板指示点', values: ['true', 'false'] },
    { name: 'indicator-color', description: '指示点颜色' },
    { name: 'indicator-active-color', description: '当前选中的指示点颜色' },
    { name: 'autoplay', description: '是否自动切换', values: ['true', 'false'] },
    { name: 'current', description: '当前所在滑块的 index' },
    { name: 'interval', description: '自动切换时间间隔，单位 ms' },
    { name: 'duration', description: '滑动动画时长，单位 ms' },
    { name: 'circular', description: '是否采用衔接滑动', values: ['true', 'false'] },
    { name: 'vertical', description: '滑动方向是否为纵向', values: ['true', 'false'] },
    { name: 'display-multiple-items', description: '同时显示的滑块数量' },
    { name: 'previous-margin', description: '前边距，可露出前一项的一小部分' },
    { name: 'next-margin', description: '后边距，可露出后一项的一小部分' },
    { name: 'bindchange', description: 'current 改变时触发，detail = {current, source}' },
    { name: 'bindtransition', description: '随着滑动时触发' },
    { name: 'bindanimationfinish', description: '动画结束时触发' },
  ] },
  { name: 'swiper-item', description: '滑块项，仅可放在 swiper 内。' },
  { name: 'movable-area', description: 'movable-view 的可移动区域。' },
  { name: 'movable-view', description: '可移动视图，必须在 movable-area 内。', attrs: [
    { name: 'direction', description: '移动方向', values: ['all', 'vertical', 'horizontal', 'none'] },
  ] },
  { name: 'cover-view', description: '覆盖原生组件的文本视图。' },
  { name: 'cover-image', description: '覆盖原生组件的图像视图。', attrs: [{ name: 'src' }] },
  { name: 'text', description: '文本组件，支持选择/换行/转义。', attrs: [
    { name: 'user-select', description: '文本是否可选', values: ['true', 'false'] },
    { name: 'space', description: '显示连续空格', values: ['ensp', 'emsp', 'nbsp'] },
    { name: 'decode', description: '是否解码 &nbsp; &lt; 等', values: ['true', 'false'] },
  ] },
  { name: 'rich-text', description: '富文本组件，支持 nodes 字符串/数组。', attrs: [{ name: 'nodes' }] },
  { name: 'icon', description: '图标。', attrs: [
    { name: 'type', values: ['success', 'info', 'warn', 'waiting', 'cancel', 'download', 'search', 'clear'] },
    { name: 'size', description: '图标大小，默认 23' },
    { name: 'color', description: '图标颜色' },
  ] },
  { name: 'progress', description: '进度条。', attrs: [
    { name: 'percent', description: '百分比 0~100' },
    { name: 'show-info', description: '右侧显示百分比' },
    { name: 'color', description: '进度条颜色' },
  ] },
  { name: 'button', description: '按钮组件。', attrs: [
    { name: 'type', values: ['primary', 'default', 'warn'], description: '按钮样式类型' },
    { name: 'size', values: ['default', 'mini'], description: '按钮大小' },
    { name: 'plain', description: '镂空，背景色透明', values: ['true', 'false'] },
    { name: 'disabled', description: '是否禁用', values: ['true', 'false'] },
    { name: 'loading', description: '名称前是否带 loading 图标', values: ['true', 'false'] },
    { name: 'form-type', values: ['submit', 'reset'], description: '用于 form，点击触发提交/重置' },
    { name: 'open-type', values: ['contact', 'share', 'getPhoneNumber', 'getUserInfo', 'launchApp', 'openSetting', 'feedback'], description: '微信开放能力' },
    { name: 'hover-class', description: '指定按下去的样式类' },
    { name: 'hover-stop-propagation', description: '阻止祖先节点出现点击态' },
    { name: 'bindtap', description: '点击事件' },
  ] },
  { name: 'form', description: '表单容器，用于将组件内的用户输入提交。', attrs: [
    { name: 'bindsubmit', description: '携带 form 中的数据触发' },
    { name: 'bindreset', description: '表单重置时触发' },
  ] },
  { name: 'input', description: '输入框。', attrs: [
    { name: 'value', description: '输入框初始内容' },
    { name: 'type', values: ['text', 'number', 'idcard', 'digit', 'safe-password', 'nickname'], description: 'input 类型' },
    { name: 'password', description: '是否密码输入', values: ['true', 'false'] },
    { name: 'placeholder', description: 'placeholder 文字' },
    { name: 'placeholder-style', description: 'placeholder 内联样式' },
    { name: 'placeholder-class', description: 'placeholder 样式类' },
    { name: 'disabled', description: '是否禁用', values: ['true', 'false'] },
    { name: 'maxlength', description: '最大输入长度，-1 不限制' },
    { name: 'focus', description: '自动聚焦/获取焦点', values: ['true', 'false'] },
    { name: 'confirm-type', values: ['send', 'search', 'next', 'go', 'done'], description: '键盘右下角按钮文字' },
    { name: 'cursor', description: '指定 focus 时的光标位置' },
    { name: 'cursor-color', description: '光标颜色' },
    { name: 'adjust-position', description: '键盘弹起时是否自动上推页面', values: ['true', 'false'] },
    { name: 'bindinput', description: '键盘输入时触发' },
    { name: 'bindfocus', description: '聚焦时触发' },
    { name: 'bindblur', description: '失焦时触发' },
    { name: 'bindconfirm', description: '点击完成按钮时触发' },
  ] },
  { name: 'textarea', description: '多行输入框。', attrs: [
    { name: 'value' }, { name: 'placeholder' }, { name: 'maxlength' },
    { name: 'auto-height', description: '自动增高' }, { name: 'bindinput' },
  ] },
  { name: 'checkbox', description: '多选项。', attrs: [
    { name: 'value' }, { name: 'disabled' }, { name: 'checked' }, { name: 'color' },
  ] },
  { name: 'checkbox-group', description: 'checkbox 容器。', attrs: [{ name: 'bindchange' }] },
  { name: 'radio', description: '单选项。', attrs: [
    { name: 'value' }, { name: 'checked' }, { name: 'disabled' }, { name: 'color' },
  ] },
  { name: 'radio-group', description: 'radio 容器。', attrs: [{ name: 'bindchange' }] },
  { name: 'switch', description: '开关。', attrs: [
    { name: 'checked' }, { name: 'disabled' },
    { name: 'type', values: ['switch', 'checkbox'] }, { name: 'color' }, { name: 'bindchange' },
  ] },
  { name: 'slider', description: '滑动选择器。', attrs: [
    { name: 'min' }, { name: 'max' }, { name: 'step' }, { name: 'value' }, { name: 'disabled' },
    { name: 'show-value', description: '是否显示当前 value' }, { name: 'bindchange' },
  ] },
  { name: 'picker', description: '从底部弹起的滚动选择器。', attrs: [
    { name: 'mode', values: ['selector', 'multiSelector', 'time', 'date', 'region'] },
    { name: 'value' }, { name: 'range' }, { name: 'range-key' }, { name: 'bindchange' },
  ] },
  { name: 'picker-view', description: '内嵌页面的滚动选择器。' },
  { name: 'picker-view-column', description: 'picker-view 子项。' },
  { name: 'label', description: '改进表单组件的可用性。', attrs: [{ name: 'for', description: '绑定控件 id' }] },
  { name: 'navigator', description: '页面跳转。', attrs: [
    { name: 'url', description: '当前应用内的跳转链接' },
    { name: 'open-type', values: ['navigate', 'redirect', 'switchTab', 'reLaunch', 'navigateBack', 'exit'], description: '跳转方式' },
    { name: 'delta', description: 'open-type 为 navigateBack 时有效，回退层数' },
    { name: 'target', values: ['self', 'miniProgram'], description: '跳转目标，本小程序或其他小程序' },
    { name: 'app-id', description: 'target=miniProgram 时要打开的小程序 appId' },
    { name: 'path', description: 'target=miniProgram 时要打开的页面路径' },
    { name: 'hover-class', description: '指定按下去的样式类' },
    { name: 'hover-stop-propagation', description: '阻止祖先节点出现点击态' },
  ] },
  { name: 'image', description: '图片。', attrs: [
    { name: 'src', description: '图片资源地址' },
    { name: 'mode', values: ['scaleToFill', 'aspectFit', 'aspectFill', 'widthFix', 'heightFix', 'top', 'bottom', 'center', 'left', 'right'], description: '图片裁剪/缩放模式' },
    { name: 'lazy-load', description: '图片懒加载', values: ['true', 'false'] },
    { name: 'binderror', description: '图片加载错误时触发' },
    { name: 'bindload', description: '图片载入完毕时触发' },
  ] },
  { name: 'audio', description: '音频。', attrs: [{ name: 'src' }, { name: 'controls' }, { name: 'loop' }] },
  { name: 'video', description: '视频。', attrs: [
    { name: 'src' }, { name: 'controls' }, { name: 'autoplay' }, { name: 'loop' }, { name: 'muted' },
    { name: 'object-fit', values: ['contain', 'fill', 'cover'] }, { name: 'bindplay' }, { name: 'bindpause' },
  ] },
  { name: 'camera', description: '相机，限制：同一时刻只能有一个相机组件。' },
  { name: 'map', description: '地图。', attrs: [
    { name: 'longitude' }, { name: 'latitude' }, { name: 'scale', description: '缩放级别 3~20' },
    { name: 'markers', description: '标记点数组' }, { name: 'show-location' },
  ] },
  { name: 'canvas', description: '画布。', attrs: [
    { name: 'type', values: ['2d', 'webgl'] }, { name: 'canvas-id' }, { name: 'id' },
  ] },
  { name: 'open-data', description: '展示微信开放能力数据。', attrs: [
    { name: 'type', values: ['groupName', 'userNickName', 'userAvatarUrl', 'userGender', 'userCity'] },
  ] },
  { name: 'web-view', description: '承载网页的容器。', attrs: [{ name: 'src' }, { name: 'bindmessage' }, { name: 'bindload' }] },
  { name: 'wxs', description: '类似 JS 的脚本模块，仅可在 wxml 内使用。', attrs: [
    { name: 'module', description: '当前 wxs 模块名' }, { name: 'src', description: '引入外部 wxs 模块路径' },
  ] },
  { name: 'template', description: 'wxml 模板，支持 name / is / data。', attrs: [
    { name: 'name' }, { name: 'is' }, { name: 'data' },
  ] },
  { name: 'block', description: '不渲染节点的包装器，用于配合 wx:if/wx:for。' },
  { name: 'import', description: '导入 wxml 模板文件。', attrs: [{ name: 'src' }] },
  { name: 'include', description: '将目标 wxml 文件除 template 外整段插入。', attrs: [{ name: 'src' }] },
  { name: 'slot', description: '组件插槽。', attrs: [{ name: 'name' }] },
]

const DIRECTIVES: Attr[] = [
  { name: 'wx:if', description: '条件渲染。值为 truthy 时该节点渲染。' },
  { name: 'wx:elif', description: '配合 wx:if 的 else if 分支。' },
  { name: 'wx:else', description: '配合 wx:if 的 else 分支。' },
  { name: 'wx:for', description: '列表渲染。遍历数组生成多个节点。' },
  { name: 'wx:for-item', description: '自定义列表项变量名，默认为 item。' },
  { name: 'wx:for-index', description: '自定义列表项索引变量名，默认为 index。' },
  { name: 'wx:key', description: '列表 diff 所需的唯一标识，强烈建议提供。' },
]

const GLOBAL_ATTRS: Attr[] = [
  { name: 'id', description: '组件唯一标识符。' },
  { name: 'class', description: 'CSS 类名。' },
  { name: 'style', description: '内联样式。支持 {{}} 表达式。' },
  { name: 'hidden', description: 'display:none 切换显隐（节点仍存在）。' },
  ...DIRECTIVES,
]

const EVENTS = [
  'tap', 'longpress', 'touchstart', 'touchmove', 'touchend', 'input', 'change',
  'submit', 'reset', 'focus', 'blur', 'confirm', 'scroll', 'load', 'error',
]

function toHtmlData(): HTMLDataV1 {
  const valueSets: NonNullable<HTMLDataV1['valueSets']> = []
  let setSeq = 0
  function valueSet(values?: string[]): string | undefined {
    if (!values || values.length === 0) return undefined
    const name = `vs${setSeq++}`
    valueSets.push({ name, values: values.map((v) => ({ name: v })) })
    return name
  }

  const eventAttrs = EVENTS.flatMap((e) => [
    { name: `bind${e}`, description: `绑定 ${e} 事件（冒泡）` },
    { name: `catch${e}`, description: `绑定 ${e} 事件（阻止冒泡）` },
  ])

  return {
    version: 1.1,
    tags: TAGS.map((t) => ({
      name: t.name,
      description: t.description,
      attributes: (t.attrs ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        valueSet: valueSet(a.values),
      })),
    })),
    globalAttributes: [
      ...GLOBAL_ATTRS.map((a) => ({ name: a.name, description: a.description })),
      ...eventAttrs,
    ],
    valueSets,
  }
}

export function createWxmlDataProvider(): IHTMLDataProvider {
  return newHTMLDataProvider('wxml', toHtmlData())
}

export const WXML_LANGUAGE_ID = 'wxml'
