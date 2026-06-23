/**
 * Customize the embedded Chrome DevTools front-end's panel tab bar.
 *
 * The right-panel DevTools (a WebContents rendering `devtools://`, attached to the
 * service-host via `setDevToolsWebContents` + `openDevTools`) shows ALL its panels
 * by default. For the mini-app workflow only Elements / Console / Network are
 * meaningful in the default tab bar — but we do NOT want to delete the rest: they
 * stay reachable on demand via the command menu (Cmd+Shift+P → "Show Sources" …).
 *
 * ── How (registry, not DOM) ─────────────────────────────────────────────────
 * The modern ESM DevTools front-end does NOT expose `UI.ViewManager` on
 * `globalThis`, so the tab bar can't be driven through the view manager. Panels
 * register themselves via `registerViewExtension({id, location:'panel', persistence})`
 * into a module-level registry; the official mutators are `registerViewExtension`,
 * `getRegisteredViewExtensions` and `maybeRemoveViewExtension`. We:
 *   1. `import('./ui/legacy/legacy.js')` to reach those functions (the real export
 *      path on Electron 41 / Chromium ~138, verified at runtime);
 *   2. whitelist-patch `registerViewExtension` so any future non-kept panel comes
 *      in with `persistence:'transient'` (hidden from the default bar);
 *   3. for the already-registered non-kept panels, `maybeRemoveViewExtension(id)`
 *      then re-register a copy with `persistence:'transient'`.
 * Transient views are not shown in the default tab bar but stay in the command
 * menu — and because this is DevTools' own panel path, there is NO `>>` overflow
 * or `×` close-button residue (which a DOM `display:none` hack leaves behind).
 *
 * ── Locale infobar ──────────────────────────────────────────────────────────
 * The "DevTools is now available in 中文" banner is suppressed via the official
 * host preference `disable-locale-info-bar` (a GLOBAL setting that lives in host
 * preferences, NOT page localStorage), set through `InspectorFrontendHost.setPreference`.
 *
 * ── Degradation ─────────────────────────────────────────────────────────────
 * If the ESM module can't be resolved, a bounded DOM `display:none` fallback hides
 * the non-kept tabs (by visible name) so the bar still looks right. Everything is
 * wrapped in try/catch in the injected realm and silently no-ops on any failure.
 */

/**
 * Canonical DevTools panel view ids kept in the DEFAULT tab bar (stable front-end
 * ids, unchanged for many Chromium releases): `elements`, `console`, `network`,
 * `sources`. Sources stays so a source-link click that isn't routed to Monaco
 * (build/runtime chunks, framework frames) still has a panel to reveal in instead
 * of silently no-op'ing.
 */
export const DEVTOOLS_KEPT_VIEW_IDS: readonly string[] = ['elements', 'console', 'network', 'sources']

/**
 * Build the `executeJavaScript` source injected into the DevTools front-end
 * WebContents. The kept ids + display names are carried as JSON data literals
 * (never interpolated as bare code), same discipline as the other injectors.
 */
export function buildCustomizeTabsScript(
  keptIds: readonly string[] = DEVTOOLS_KEPT_VIEW_IDS,
): string {
  // Kept panels are matched by view id (registry path) and by visible NAME (DOM
  // fallback path); the DevTools UI may be EN or ZH, so include both.
  const NAME_MAP: Record<string, string[]> = {
    elements: ['Elements', '元素'], console: ['Console', '控制台'], network: ['Network', '网络'],
    sources: ['Sources', '来源', '源代码'],
  }
  const keepNames = keptIds.flatMap((id) => NAME_MAP[id] ?? [id])
  const keepIdsJson = JSON.stringify(JSON.stringify([...keptIds]))
  const keepNamesJson = JSON.stringify(JSON.stringify(keepNames))
  return `(function(){try{
    var KEEPID = new Set(JSON.parse(${keepIdsJson}));
    var KEEPNAME = new Set(JSON.parse(${keepNamesJson}));
    // (1) Locale infobar — official host-preference suppression (NOT localStorage).
    try { var IFH=globalThis.InspectorFrontendHost; if(IFH&&typeof IFH.setPreference==='function'){ IFH.setPreference('disable-locale-info-bar','true'); } }catch(_){}
    function deepCollect(sel,cap){ var out=[],seen=0,stack=[document]; while(stack.length&&seen<(cap||40000)){ var root=stack.pop(); try{var m=root.querySelectorAll?root.querySelectorAll(sel):[];for(var i=0;i<m.length;i++)out.push(m[i]);}catch(_){} try{var all=root.querySelectorAll?root.querySelectorAll('*'):[];for(var j=0;j<all.length;j++){seen++;if(all[j].shadowRoot)stack.push(all[j].shadowRoot);}}catch(_){} } return out; }
    function txt(el){ return ((el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
    var PATHS=['./ui/legacy/legacy.js','./ui/legacy/ViewManager.js','devtools://devtools/bundled/ui/legacy/legacy.js'];
    (async function(){
      var VM=null,maybeRemove=null,origReg=null,reg=null,getReg=null;
      for(var i=0;i<PATHS.length;i++){ try{ var m=await import(PATHS[i]); if(!m)continue; var v=m.ViewManager||m;
        var mr=(v&&typeof v.maybeRemoveViewExtension==='function')?v.maybeRemoveViewExtension.bind(v):(typeof m.maybeRemoveViewExtension==='function'?m.maybeRemoveViewExtension:null);
        if(mr){ VM=v;maybeRemove=mr;
          origReg=(v&&typeof v.registerViewExtension==='function')?v.registerViewExtension:m.registerViewExtension; reg=origReg;
          getReg=(v&&typeof v.getRegisteredViewExtensions==='function')?v.getRegisteredViewExtensions.bind(v):(typeof m.getRegisteredViewExtensions==='function'?m.getRegisteredViewExtensions:null);
          break; } }catch(_){} }
      if(maybeRemove){
        // (2) future non-kept panels register as transient
        try{ if(origReg&&VM){ VM.registerViewExtension=function(r){ try{ if(r&&String(r.location)==='panel'&&!KEEPID.has(r.id)){ r.persistence='transient'; } }catch(_){} return origReg.apply(this,arguments); }; reg=VM.registerViewExtension; } }catch(_){}
        // (3) already-registered non-kept panels -> remove + re-register transient
        var exts=[]; try{ if(getReg) exts=getReg()||[]; }catch(_){}
        var handled=false;
        for(var e=0;e<exts.length;e++){ try{ var ex=exts[e]; var eid=ex&&ex.id; if(!eid||KEEPID.has(eid)) continue; if(String(ex.location)!=='panel') continue;
          maybeRemove(eid);
          var nr={}; try{ nr=Object.assign({},ex); }catch(_){ for(var k in ex){ try{nr[k]=ex[k];}catch(__){} } }
          nr.persistence='transient';
          try{ reg(nr); }catch(_){ try{ origReg(nr); }catch(__){} }
          handled=true;
        }catch(_){} }
        // fallback: registrations not enumerable -> at least clear the bar by id
        if(!handled){ var FALL=['timeline','resources','heap-profiler','security','lighthouse','chrome-recorder','coverage','linear-memory-inspector','sensors','rendering','animations','autofill-view','medias','issues-pane']; for(var fr=0;fr<FALL.length;fr++){ try{ if(!KEEPID.has(FALL[fr])) maybeRemove(FALL[fr]); }catch(_){} } }
      } else { domFallback(); }
    })();
    // DOM fallback: only if the ESM module couldn't be resolved at all.
    function domFallback(){ var cachedBar=null;
      function findBar(){ if(cachedBar&&cachedBar.isConnected)return cachedBar; cachedBar=null; var tabs=deepCollect('[role="tab"]'); var a=null; for(var i=0;i<tabs.length;i++){if(KEEPNAME.has(txt(tabs[i]))){a=tabs[i];break;}} if(!a)return null; var p=a.parentElement; while(p){try{if(p.querySelectorAll('[role="tab"]').length>1){cachedBar=p;return p;}}catch(_){} p=p.parentElement;} cachedBar=a.parentElement; return cachedBar; }
      function apply(){ try{ var bar=findBar(); if(bar){ var bts=bar.querySelectorAll('[role="tab"]'); for(var b=0;b<bts.length;b++){var bt=bts[b]; if(KEEPNAME.has(txt(bt)))continue; try{if(bt.style)bt.style.display='none';}catch(_){}} try{var more=bar.querySelector('[aria-label*="More tabs"],.tabbed-pane-header-tabs-drop-down-container'); if(more&&more.style)more.style.display='none';}catch(_){} } }catch(_){} }
      var tr=0,t=setInterval(function(){tr++;try{apply();}catch(_){}if(tr>120)clearInterval(t);},60); try{apply();}catch(_){} }
  }catch(_){}})()`
}
