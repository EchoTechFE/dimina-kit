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
    ignores: ["container/**", "docs/**", "templates/**", "e2e/fixtures/**", "_spike/**", "spike/**", "playwright-report/**", "test-results/**", "coverage/**"],
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
  // a module-local narrow deps interface instead.
  //
  // EXEMPTION MECHANISM (round 3): exemptions are PER-LINE inline directives,
  // not per-file config entries. Each violation existing when the ratchet
  // landed carries
  //   // eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
  // directly above it. The inline marker set is shrink-only: migrate a line
  // to a narrow contract / module-local deps interface, then delete its
  // marker — never add new markers. Because there is no whole-file
  // exemption, a NEW violation added to ANY file (including files that
  // already carry grandfathered lines, and the assembly/barrel files
  // app.ts / miniapp-runtime.ts / api.ts) is reported by CI.
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
            "Ratchet: do not import WorkbenchContext outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
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
            "Ratchet: do not namespace-import workbench-context outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
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
            "Ratchet: do not type-query import('…/workbench-context.js') outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
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
            "Ratchet: do not re-export WorkbenchContext outside assembly layers — that creates a new distribution point for the grab-bag. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
        },
        {
          // Export-star bypass: `export * from '…/workbench-context.js'`
          // re-exports the whole barrel (WorkbenchContext included) with no
          // specifier node of any kind. Keyed on the module source —
          // export-star of unrelated modules stays allowed.
          selector:
            "ExportAllDeclaration[source.value=/workbench-context(\\.js)?$/]",
          message:
            "Ratchet: do not `export *` from workbench-context outside assembly layers — it re-exports the whole grab-bag. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
        },
        {
          // Dynamic-import bypass: a RUNTIME `import('…/workbench-context.js')`
          // is an ImportExpression node (fields: `source` Literal +
          // `options`) — not an ImportDeclaration and not a TSImportType
          // (type-position only) — so it needs its own selector. Keyed on
          // the module source; lazy-loading unrelated modules stays allowed.
          selector:
            "ImportExpression[source.value=/workbench-context(\\.js)?$/]",
          message:
            "Ratchet: do not dynamically import('…/workbench-context.js') outside assembly layers. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
        },
        {
          // Module-augmentation bypass: `declare module '…/workbench-context.js'
          // {…}` is a TSModuleDeclaration — no import/export node of any
          // kind — yet it WIDENS the grab-bag's interface for everyone. For
          // a string-named module the `id` is a Literal (has `.value`); for
          // `declare module SomeNs {}` the id is an Identifier with no
          // `value` field, so this selector cannot misfire on namespace
          // declarations. Keyed on the module source — `declare module
          // 'electron'` augmentation stays allowed.
          selector:
            "TSModuleDeclaration[id.value=/workbench-context(\\.js)?$/]",
          message:
            "Ratchet: do not augment ('declare module') workbench-context outside assembly layers — that silently widens the grab-bag for everyone. Depend on MiniappRuntime / MenuContext / a module-local narrow deps interface instead (exemptions are inline grandfathered(workbench-context) directives; shrink-only).",
        },
      ],
    },
  },
];
