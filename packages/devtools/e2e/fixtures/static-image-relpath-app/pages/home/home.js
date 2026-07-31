Page({
  data: {
    // Same shape as the downstream report: a page-relative local static path.
    // The compiler may rewrite the wxml literal; this data path still exercises
    // runtime local-src resolution against the render-host document URL.
    avatarSrc: '../../static/avatars/probe.png',
  },
})
