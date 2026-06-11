import globals from "globals";
import { config } from "@dimina-kit/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // templates/ are scaffolds copied verbatim into user projects (with wx/App/Page
    // globals + Taro-compiled minified bundles); e2e/fixtures/ are mini-app source
    // fixtures (same wx/Page globals) + compiled bundles; _spike/ and spike/ are
    // throwaway prototype scratch; playwright-report and test-results are e2e
    // artifacts. None of these are source we maintain — skip linting them.
    ignores: ["container/**", "docs/**", "templates/**", "e2e/fixtures/**", "_spike/**", "spike/**", "playwright-report/**", "test-results/**"],
  },
  {
    files: [
      "*.config.{js,cjs,mjs,ts}",
      "vite.config.*.{js,cjs,mjs,ts}",
      "build-container.js",
      "build-native-host.mjs",
      "e2e/**/*.{js,cjs,mjs,ts}",
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "src/shared/**/*.ts",
      "src/simulator/**/*.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["e2e/**/*.{ts,js}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    // Electron `<webview>` carries attributes React's DOM checker doesn't know
    // (preload/partition/allowpopups/…). They are valid on the webview tag.
    files: ["src/**/*.tsx"],
    rules: {
      "react/no-unknown-property": [
        "error",
        { ignore: ["preload", "partition", "allowpopups", "nodeintegration", "webpreferences", "disablewebsecurity", "useragent"] },
      ],
    },
  },
  {
    // Hand-written CommonJS preloads + their pure `.cjs` siblings are loaded by
    // Electron at runtime by path and copied verbatim by build-native-host.mjs
    // (never transpiled), so they legitimately use `require`/`module` in a Node
    // CJS scope while also touching browser globals (they run in a renderer).
    // Provide only the CJS module globals (not all of `globals.node`, which
    // would shadow browser globals like `reportError` the preloads define) and
    // allow the CJS module syntax.
    files: ["src/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      // The preloads define helper functions (e.g. `reportError`) that collide
      // with seldom-used browser built-ins of the same name; the local binding
      // is intentional, so don't flag the shadow in these hand-written files.
      "no-redeclare": "off",
    },
  },
  // Renderer must funnel every IPC call through `shared/api/ipc-transport`
  // and never reach into the raw preload bridge. The transport file itself
  // is the only legitimate consumer of `window.devtools.ipc`; it disables
  // this rule inline.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='window'][object.property.name='devtools'][property.name='ipc']",
          message:
            "Use the helpers exported from `@/shared/api/ipc-transport` instead of touching `window.devtools.ipc` directly.",
        },
      ],
    },
  },
  // ── WorkbenchContext import RATCHET ───────────────────────────────────────
  // Production modules must not grow new dependencies on the full
  // `WorkbenchContext` grab-bag: depend on `MiniappRuntime` / `MenuContext` /
  // a module-local narrow deps interface instead. The exception list below is
  // a one-time, MECHANICALLY ENUMERATED snapshot of the violations existing
  // when the ratchet landed (0.4.0) — per-file, never directory globs. Files
  // may only ever LEAVE the grandfathered list; any new file importing
  // WorkbenchContext fails CI.
  {
    files: [
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "src/shared/**/*.ts",
      "src/simulator/**/*.ts",
    ],
    ignores: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportSpecifier[imported.name='WorkbenchContext']",
          message:
            "Ratchet: do not import WorkbenchContext outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (see the enumerated exception list in eslint.config.js).",
        },
        {
          // Namespace bypass: `import * as Wb from '…/workbench-context.js'`
          // (and the `import type * as` flavor — same AST shape, importKind
          // differs) reaches the full grab-bag without an ImportSpecifier
          // node. Matched by import SOURCE since a namespace import names no
          // specifier; covers both value and type flavors.
          selector:
            "ImportDeclaration[source.value=/workbench-context(\\.js)?$/] ImportNamespaceSpecifier",
          message:
            "Ratchet: do not namespace-import workbench-context outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (see the enumerated exception list in eslint.config.js).",
        },
        {
          // Type-query bypass: `type T = import('…/workbench-context.js').X`
          // is a TSImportType node — no ImportDeclaration, no specifier.
          // Matched by import SOURCE (not the qualifier): a qualifier-free
          // `import('…/workbench-context.js')` yields the whole module type,
          // so keying on `qualifier.name` would leave that hole open — same
          // reasoning as the namespace-import selector above.
          selector: "TSImportType[source.value=/workbench-context(\\.js)?$/]",
          message:
            "Ratchet: do not type-query import('…/workbench-context.js') outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (see the enumerated exception list in eslint.config.js).",
        },
        {
          // Re-export bypass: `export { WorkbenchContext } from '…'` (plus
          // the aliased and `export type {…}` flavors — identical
          // ExportSpecifier shape, so one selector covers all three). Keyed
          // on `local.name` (the alias lives on `exported.name`) and scoped
          // to declarations whose SOURCE is workbench-context, so exporting
          // a locally defined `WorkbenchContext` symbol is not misflagged.
          selector:
            "ExportNamedDeclaration[source.value=/workbench-context(\\.js)?$/] ExportSpecifier[local.name='WorkbenchContext']",
          message:
            "Ratchet: do not re-export WorkbenchContext outside assembly layers — that creates a new distribution point for the grab-bag. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (see the enumerated exception list in eslint.config.js).",
        },
        {
          // Export-star bypass: `export * from '…/workbench-context.js'`
          // re-exports the whole barrel (WorkbenchContext included) with no
          // specifier node of any kind. Keyed on the module source —
          // export-star of unrelated modules stays allowed.
          selector:
            "ExportAllDeclaration[source.value=/workbench-context(\\.js)?$/]",
          message:
            "Ratchet: do not `export *` from workbench-context outside assembly layers — it re-exports the whole grab-bag. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (see the enumerated exception list in eslint.config.js).",
        },
      ],
    },
  },
  {
    files: [
      // ── Legitimate assembly / contract layer (permanent whitelist) ──
      // workbench-context.ts itself defines the type; these are the real
      // composition points that wire the full context together or view it
      // down to the public contract.
      "src/main/app/app.ts",
      "src/main/runtime/miniapp-runtime.ts",
      // api.ts is the package's public API barrel: re-exporting the
      // WorkbenchContext type there is the intended public surface, not a
      // violation to migrate away from.
      "src/main/api.ts",
      // ── Grandfathered violations (ratchet snapshot, 0.4.0) ──
      // grep-generated; shrink-only. Migrate each to a narrow contract or
      // module-local deps interface, then delete its line.
      "src/main/ipc/app.ts",
      "src/main/ipc/bridge-router.ts",
      "src/main/ipc/popover.ts",
      "src/main/ipc/project-fs.ts",
      "src/main/ipc/projects.ts",
      "src/main/ipc/session.ts",
      "src/main/ipc/settings.ts",
      "src/main/ipc/simulator.ts",
      "src/main/ipc/views.ts",
      "src/main/services/automation/exec.ts",
      "src/main/services/automation/index.ts",
      "src/main/services/automation/shared.ts",
      "src/main/services/module.ts",
      "src/main/services/views/view-manager.ts",
      "src/main/services/workspace/workspace-service.ts",
      "src/main/utils/sender-policy.ts",
      "src/main/windows/main-window/events.ts",
      // round-2 ratchet (TSImportType selector) snapshot: type-query import
      // at src/shared/types.ts:132.
      "src/shared/types.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
