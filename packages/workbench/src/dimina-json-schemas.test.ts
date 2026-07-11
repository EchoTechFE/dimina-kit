/**
 * Guards the dimina config-file schema contract: the three schemas exist and
 * carry the compiler-grounded fields (see the module doc — `pages`, `window`,
 * `tabBar.list[].pagePath`, `usingComponents`, project.config keys), the
 * schema registry associates each config file with its schema, and
 * `pickSchemaUri` routes a document path to the right schema URI (app.json
 * only at the project root — an app.json nested under pages/ is page config).
 */
import { describe, expect, it } from 'vitest'
import {
  APP_JSON_SCHEMA,
  DIMINA_JSON_SCHEMAS,
  PAGE_JSON_SCHEMA,
  PROJECT_CONFIG_SCHEMA,
  pickSchemaUri,
} from './dimina-json-schemas.js'

describe('dimina JSON schemas', () => {
  it('app.json schema covers the fields the dimina compiler reads', () => {
    const props = APP_JSON_SCHEMA.properties ?? {}
    for (const key of ['pages', 'window', 'tabBar', 'subPackages']) {
      expect(props, `app.json schema missing '${key}'`).toHaveProperty(key)
    }
  })

  it('page schema allows usingComponents; project.config schema carries appid', () => {
    expect(PAGE_JSON_SCHEMA.properties ?? {}).toHaveProperty('usingComponents')
    expect(PROJECT_CONFIG_SCHEMA.properties ?? {}).toHaveProperty('appid')
  })

  it('registry associates each config file with a distinct stable URI', () => {
    const uris = DIMINA_JSON_SCHEMAS.map((e) => e.uri)
    expect(new Set(uris).size).toBe(uris.length)
    for (const entry of DIMINA_JSON_SCHEMAS) {
      expect(entry.fileMatch.length).toBeGreaterThan(0)
      expect(entry.uri).toMatch(/^dimina:\/\/schemas\//)
    }
  })

  it('pickSchemaUri routes root app.json / project configs / everything else', () => {
    expect(pickSchemaUri('/workspace/app.json')).toBe('dimina://schemas/app.json')
    expect(pickSchemaUri('/workspace/project.config.json')).toBe('dimina://schemas/project.config.json')
    expect(pickSchemaUri('/workspace/project.private.config.json')).toBe('dimina://schemas/project.config.json')
    // A nested app.json under pages/ is PAGE config, not the global one.
    expect(pickSchemaUri('/workspace/pages/app/app.json')).toBe('dimina://schemas/page.json')
    expect(pickSchemaUri('/workspace/pages/home/home.json')).toBe('dimina://schemas/page.json')
  })
})
