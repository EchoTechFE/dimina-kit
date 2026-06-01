/**
 * wxml-data — 微信小程序 WXML 标签 / 属性 / 指令元数据。
 *
 * 来源：https://developers.weixin.qq.com/miniprogram/dev/component/
 * （组件文档树第一级 — 视图容器 / 基础内容 / 表单 / 导航 / 媒体 / 画布 /
 *  地图 / 开放能力）。仅收录公开稳定组件，跳过 deprecated 与 wx 内部组件。
 *
 * 元数据用于 monaco completion / hover provider。NOT a full LSP server —
 * 我们没有 schema 校验也没 diagnostics，只把"标签 / 属性能补全 + hover 出
 * 一段文档"这件事做了。
 */

export interface WxmlAttr {
  name: string;
  description?: string;
  /** required boolean → 优先级前置 */
  required?: boolean;
  /** 枚举值（如 type=primary|default|warn） */
  values?: string[];
}

export interface WxmlTag {
  name: string;
  description: string;
  attrs?: WxmlAttr[];
}

/**
 * 微信组件标签清单。覆盖度目标：官方文档"基础组件"小节里 90%+ 的常用组件。
 * 描述刻意精简（hover 只显示一行 + link），完整文档由用户点链接看。
 */
export const WXML_TAGS: WxmlTag[] = [
  // ===== 视图容器 =====
  {
    name: 'view',
    description: '视图容器，最基础的块级容器，类似 div。',
    attrs: [
      { name: 'hover-class', description: '指定按下去的样式类' },
      { name: 'hover-stop-propagation', description: '阻止父元素 hover 状态' },
      { name: 'hover-start-time', description: '按住后多久出现点击态，单位 ms' },
      { name: 'hover-stay-time', description: '手指松开后点击态保留时间，单位 ms' },
    ],
  },
  {
    name: 'scroll-view',
    description: '可滚动视图区域，支持横/纵向滚动、下拉刷新、滚动到指定位置。',
    attrs: [
      { name: 'scroll-x', description: '允许横向滚动', values: ['true', 'false'] },
      { name: 'scroll-y', description: '允许纵向滚动', values: ['true', 'false'] },
      { name: 'upper-threshold', description: '距顶部多少触发 scrolltoupper 事件，px' },
      { name: 'lower-threshold', description: '距底部多少触发 scrolltolower 事件，px' },
      { name: 'scroll-top', description: '设置竖向滚动条位置' },
      { name: 'scroll-left', description: '设置横向滚动条位置' },
      { name: 'scroll-into-view', description: '滚动到指定子元素，传 id' },
      { name: 'scroll-with-animation', description: '滚动是否带动画' },
      { name: 'enable-back-to-top', description: 'iOS 顶部状态栏点击回到顶部' },
      { name: 'refresher-enabled', description: '开启下拉刷新' },
      { name: 'refresher-triggered', description: '下拉刷新状态' },
      { name: 'bindscrolltoupper', description: '滚动到顶部触发' },
      { name: 'bindscrolltolower', description: '滚动到底部触发' },
      { name: 'bindscroll', description: '滚动触发' },
      { name: 'bindrefresherrefresh', description: '下拉刷新被触发' },
    ],
  },
  {
    name: 'swiper',
    description: '滑块视图容器，子元素必须为 swiper-item。',
    attrs: [
      { name: 'indicator-dots', description: '是否显示指示点', values: ['true', 'false'] },
      { name: 'indicator-color', description: '指示点颜色' },
      { name: 'indicator-active-color', description: '当前选中指示点颜色' },
      { name: 'autoplay', description: '自动切换', values: ['true', 'false'] },
      { name: 'current', description: '当前所在滑块 index' },
      { name: 'interval', description: '自动切换间隔 ms' },
      { name: 'duration', description: '滑动动画时长 ms' },
      { name: 'circular', description: '衔接滑动' },
      { name: 'vertical', description: '纵向滑动' },
      { name: 'bindchange', description: 'current 改变时触发' },
    ],
  },
  { name: 'swiper-item', description: '滑块项，仅可放在 swiper 内。' },
  {
    name: 'movable-area',
    description: 'movable-view 的可移动区域。',
    attrs: [
      { name: 'scale-area', description: '当 movable-view 设置 scale 时跟随' },
    ],
  },
  {
    name: 'movable-view',
    description: '可移动视图，必须在 movable-area 内。',
    attrs: [
      { name: 'direction', description: '移动方向', values: ['all', 'vertical', 'horizontal', 'none'] },
      { name: 'inertia', description: '是否有惯性' },
      { name: 'out-of-bounds', description: '超出边界后可继续移动' },
      { name: 'x', description: '横向偏移' },
      { name: 'y', description: '纵向偏移' },
      { name: 'damping', description: '阻尼系数' },
      { name: 'friction', description: '摩擦系数' },
    ],
  },
  { name: 'cover-view', description: '覆盖原生组件的文本视图，可覆盖 map/video/canvas。' },
  { name: 'cover-image', description: '覆盖原生组件的图像视图。', attrs: [{ name: 'src', required: true }] },
  { name: 'match-media', description: '媒体查询匹配检测节点。' },

  // ===== 基础内容 =====
  {
    name: 'text',
    description: '文本组件，支持选择/换行/转义。',
    attrs: [
      { name: 'selectable', description: '是否可选择' },
      { name: 'space', description: '空格显示', values: ['ensp', 'emsp', 'nbsp'] },
      { name: 'decode', description: '是否解码' },
    ],
  },
  { name: 'rich-text', description: '富文本组件，支持 nodes 字符串/数组。', attrs: [{ name: 'nodes' }] },
  { name: 'icon', description: '图标。', attrs: [
    { name: 'type', required: true, values: ['success', 'success_no_circle', 'info', 'warn', 'waiting', 'cancel', 'download', 'search', 'clear'] },
    { name: 'size', description: '图标大小，默认 23' },
    { name: 'color', description: '图标颜色' },
  ]},
  { name: 'progress', description: '进度条。', attrs: [
    { name: 'percent', required: true, description: '百分比 0~100' },
    { name: 'show-info', description: '右侧显示百分比' },
    { name: 'stroke-width', description: '进度条宽度' },
    { name: 'color', description: '进度条颜色' },
    { name: 'active', description: '动画显示' },
  ]},

  // ===== 表单 =====
  {
    name: 'button',
    description: '按钮组件。',
    attrs: [
      { name: 'type', values: ['primary', 'default', 'warn'], description: '按钮样式类型' },
      { name: 'size', values: ['default', 'mini'] },
      { name: 'plain', description: '镂空，背景色透明' },
      { name: 'disabled', description: '是否禁用' },
      { name: 'loading', description: '名称前是否带 loading 图标' },
      { name: 'form-type', values: ['submit', 'reset'], description: '在 form 中作为提交/重置触发器' },
      { name: 'open-type', values: ['contact', 'share', 'getPhoneNumber', 'getUserInfo', 'launchApp', 'openSetting', 'feedback'], description: '微信开放能力' },
      { name: 'hover-class', description: '按下样式类' },
      { name: 'bindtap', description: '点击事件' },
    ],
  },
  {
    name: 'form',
    description: '表单容器，用于将组件内的用户输入提交。',
    attrs: [
      { name: 'report-submit', description: '是否返回 formId' },
      { name: 'bindsubmit', description: '携带 form 中的数据触发' },
      { name: 'bindreset', description: '表单重置时触发' },
    ],
  },
  {
    name: 'input',
    description: '输入框。',
    attrs: [
      { name: 'value', description: '输入框初始内容' },
      { name: 'type', values: ['text', 'number', 'idcard', 'digit', 'safe-password', 'nickname'] },
      { name: 'password', description: '是否密码输入' },
      { name: 'placeholder', description: 'placeholder 文字' },
      { name: 'placeholder-class' },
      { name: 'maxlength', description: '最大输入长度，-1 不限制' },
      { name: 'focus', description: '获取焦点' },
      { name: 'confirm-type', values: ['send', 'search', 'next', 'go', 'done'] },
      { name: 'bindinput', description: '输入时触发' },
      { name: 'bindfocus' },
      { name: 'bindblur' },
      { name: 'bindconfirm' },
    ],
  },
  {
    name: 'textarea',
    description: '多行输入框。',
    attrs: [
      { name: 'value' },
      { name: 'placeholder' },
      { name: 'maxlength' },
      { name: 'auto-height', description: '自动增高' },
      { name: 'bindinput' },
      { name: 'bindfocus' },
      { name: 'bindblur' },
    ],
  },
  { name: 'checkbox', description: '多选项。', attrs: [
    { name: 'value', required: true },
    { name: 'disabled' },
    { name: 'checked' },
    { name: 'color' },
  ]},
  { name: 'checkbox-group', description: 'checkbox 容器。', attrs: [{ name: 'bindchange' }] },
  { name: 'radio', description: '单选项。', attrs: [
    { name: 'value', required: true },
    { name: 'checked' },
    { name: 'disabled' },
    { name: 'color' },
  ]},
  { name: 'radio-group', description: 'radio 容器。', attrs: [{ name: 'bindchange' }] },
  { name: 'switch', description: '开关。', attrs: [
    { name: 'checked' },
    { name: 'disabled' },
    { name: 'type', values: ['switch', 'checkbox'] },
    { name: 'color' },
    { name: 'bindchange' },
  ]},
  { name: 'slider', description: '滑动选择器。', attrs: [
    { name: 'min' },
    { name: 'max' },
    { name: 'step' },
    { name: 'value' },
    { name: 'disabled' },
    { name: 'activeColor' },
    { name: 'show-value', description: '是否显示当前 value' },
    { name: 'bindchange' },
    { name: 'bindchanging' },
  ]},
  { name: 'picker', description: '从底部弹起的滚动选择器。', attrs: [
    { name: 'mode', values: ['selector', 'multiSelector', 'time', 'date', 'region'] },
    { name: 'value' },
    { name: 'range' },
    { name: 'range-key' },
    { name: 'disabled' },
    { name: 'bindchange' },
    { name: 'bindcancel' },
  ]},
  { name: 'picker-view', description: '内嵌页面的滚动选择器。' },
  { name: 'picker-view-column', description: 'picker-view 子项。' },
  { name: 'label', description: '改进表单组件的可用性。', attrs: [{ name: 'for', description: '绑定控件 id' }] },

  // ===== 导航 =====
  {
    name: 'navigator',
    description: '页面跳转。',
    attrs: [
      { name: 'url', description: '跳转目标 url' },
      { name: 'open-type', values: ['navigate', 'redirect', 'switchTab', 'reLaunch', 'navigateBack', 'exit'] },
      { name: 'delta', description: 'navigateBack 时回退的层数' },
      { name: 'app-id', description: '当 open-type=launchApp 时填入' },
      { name: 'hover-class' },
    ],
  },
  { name: 'functional-page-navigator', description: '仅支持插件使用的页面跳转。' },

  // ===== 媒体 =====
  {
    name: 'image',
    description: '图片。',
    attrs: [
      { name: 'src', required: true, description: '图片资源地址' },
      { name: 'mode', values: ['scaleToFill', 'aspectFit', 'aspectFill', 'widthFix', 'heightFix', 'top', 'bottom', 'center', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'] },
      { name: 'lazy-load', description: '懒加载' },
      { name: 'show-menu-by-longpress' },
      { name: 'binderror' },
      { name: 'bindload' },
    ],
  },
  {
    name: 'audio',
    description: '音频。',
    attrs: [
      { name: 'src', required: true },
      { name: 'id' },
      { name: 'controls' },
      { name: 'loop' },
      { name: 'poster' },
      { name: 'name' },
      { name: 'author' },
    ],
  },
  {
    name: 'video',
    description: '视频。',
    attrs: [
      { name: 'src', required: true },
      { name: 'controls' },
      { name: 'autoplay' },
      { name: 'loop' },
      { name: 'muted' },
      { name: 'poster' },
      { name: 'initial-time', description: '初始播放位置 s' },
      { name: 'duration' },
      { name: 'object-fit', values: ['contain', 'fill', 'cover'] },
      { name: 'bindplay' },
      { name: 'bindpause' },
      { name: 'bindended' },
      { name: 'bindtimeupdate' },
    ],
  },
  { name: 'camera', description: '相机，限制：同一时刻只能有一个相机组件。' },
  { name: 'live-player', description: '直播播放，需要先申请。', attrs: [{ name: 'src', required: true }] },
  { name: 'live-pusher', description: '直播推流。', attrs: [{ name: 'url', required: true }] },

  // ===== 地图 =====
  {
    name: 'map',
    description: '地图。',
    attrs: [
      { name: 'longitude', required: true },
      { name: 'latitude', required: true },
      { name: 'scale', description: '缩放级别 3~20，默认 16' },
      { name: 'markers', description: '标记点数组' },
      { name: 'polyline', description: '路线数组' },
      { name: 'circles', description: '圆数组' },
      { name: 'show-location', description: '显示带方向的当前定位点' },
    ],
  },

  // ===== 画布 =====
  {
    name: 'canvas',
    description: '画布。',
    attrs: [
      { name: 'type', values: ['2d', 'webgl'] },
      { name: 'canvas-id', description: '组件唯一标识符（非 type=2d 时）' },
      { name: 'id', description: '组件 id（type=2d 时使用）' },
      { name: 'disable-scroll' },
    ],
  },

  // ===== 开放能力 =====
  { name: 'open-data', description: '展示微信开放能力数据。', attrs: [{ name: 'type', required: true, values: ['groupName', 'userNickName', 'userAvatarUrl', 'userGender', 'userCity', 'userProvince', 'userCountry', 'userLanguage'] }] },
  { name: 'web-view', description: '承载网页的容器。', attrs: [
    { name: 'src', required: true },
    { name: 'bindmessage' },
    { name: 'bindload' },
    { name: 'binderror' },
  ]},
  { name: 'ad', description: 'banner 广告。', attrs: [{ name: 'unit-id', required: true }] },
  { name: 'official-account', description: '公众号关注组件。' },

  // ===== WXS / 模板 =====
  { name: 'wxs', description: '类似 JS 的脚本模块，仅可在 wxml 内使用。', attrs: [
    { name: 'module', required: true, description: '当前 wxs 模块名' },
    { name: 'src', description: '引入外部 wxs 模块路径' },
  ]},
  { name: 'template', description: 'wxml 模板，支持 name / is / data。', attrs: [
    { name: 'name' },
    { name: 'is' },
    { name: 'data' },
  ]},
  { name: 'block', description: '不渲染节点的包装器，用于配合 wx:if/wx:for。' },
  { name: 'import', description: '导入 wxml 模板文件。', attrs: [{ name: 'src', required: true }] },
  { name: 'include', description: '将目标 wxml 文件除 template 外整段插入。', attrs: [{ name: 'src', required: true }] },
  { name: 'slot', description: '组件插槽。', attrs: [{ name: 'name' }] },
];

/** 通用指令属性（wx: 系列）。任何标签都可挂。 */
export const WXML_DIRECTIVES: WxmlAttr[] = [
  { name: 'wx:if', description: '条件渲染。值为 truthy 时该节点渲染。' },
  { name: 'wx:elif', description: '配合 wx:if 的 else if 分支。' },
  { name: 'wx:else', description: '配合 wx:if 的 else 分支，无表达式值。' },
  { name: 'wx:for', description: '列表渲染。遍历数组生成多个节点。' },
  { name: 'wx:for-item', description: '自定义列表项变量名，默认为 item。' },
  { name: 'wx:for-index', description: '自定义列表项索引变量名，默认为 index。' },
  { name: 'wx:key', description: '列表 diff 所需的唯一标识，强烈建议提供。' },
  { name: 'wx:no-repeat', description: '组件内部使用，避免重复渲染。' },
];

/**
 * 通用事件绑定属性。`bindxxx` 冒泡，`catchxxx` 阻止冒泡。
 * 这里只列常见事件名供补全；具体语义随组件而异。
 */
export const WXML_EVENTS: string[] = [
  'tap',
  'longpress',
  'longtap',
  'touchstart',
  'touchmove',
  'touchcancel',
  'touchend',
  'transitionend',
  'animationstart',
  'animationiteration',
  'animationend',
  'input',
  'change',
  'submit',
  'reset',
  'focus',
  'blur',
  'confirm',
  'scroll',
  'scrolltoupper',
  'scrolltolower',
  'load',
  'error',
];

/**
 * 通用属性（所有标签都可写）。用于在 ` ` 触发补全时插入到非"已知标签"中。
 */
export const WXML_GLOBAL_ATTRS: WxmlAttr[] = [
  { name: 'id', description: '组件唯一标识符。' },
  { name: 'class', description: 'CSS 类名。' },
  { name: 'style', description: '内联样式。支持 {{}} 表达式。' },
  { name: 'data-*', description: '自定义数据，可通过 event.currentTarget.dataset 取到。' },
  { name: 'hidden', description: 'true/false 切换显隐（与 wx:if 区别：hidden 是 display:none，节点仍存在）。' },
];

/** 输出 bindxxx / catchxxx 形式的事件绑定属性（注释里描述事件类型）。 */
export function buildEventAttrs(): WxmlAttr[] {
  const out: WxmlAttr[] = [];
  for (const e of WXML_EVENTS) {
    out.push({ name: `bind${e}`, description: `绑定 ${e} 事件（冒泡）` });
    out.push({ name: `catch${e}`, description: `绑定 ${e} 事件（阻止冒泡）` });
  }
  return out;
}

/** 按 tag name 索引化标签 map。 */
export const TAG_MAP: ReadonlyMap<string, WxmlTag> = new Map(
  WXML_TAGS.map((t) => [t.name, t] as [string, WxmlTag]),
);
