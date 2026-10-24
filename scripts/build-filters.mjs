// Downloads filter lists and compiles them into what the extension loads:
//   extension/rules/<list>.json        declarativeNetRequest static rulesets
//   extension/data/cosmetic-generic.css element-hiding rules that apply everywhere
//   extension/data/cosmetic.json       site-specific hiding + exceptions
//   extension/data/popup.json          popup/popunder rules, matched by the background worker
//
// Usage: node scripts/build-filters.mjs [--offline]   (--offline reuses .cache/)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')
const CACHE = path.join(ROOT, '.cache')
const OFFLINE = process.argv.includes('--offline')

await import('../extension/compiler.js')
const { LISTS, compile, toCss } = globalThis.HushCompiler

async function fetchList(list) {
  if (list.local) return fs.readFile(path.join(EXT, list.local), 'utf8')
  const file = path.join(CACHE, list.file)
  if (!OFFLINE) {
    try {
      const res = await fetch(list.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      await fs.mkdir(CACHE, { recursive: true })
      await fs.writeFile(file, text)
      return text
    } catch (err) {
      console.warn(`! ${list.id}: download failed (${err.message}), using cached copy`)
    }
  }
  return fs.readFile(file, 'utf8')
}

async function main() {
  await fs.mkdir(path.join(EXT, 'rules'), { recursive: true })
  await fs.mkdir(path.join(EXT, 'data'), { recursive: true })

  const texts = await Promise.all(LISTS.map(fetchList))
  const { rulesets, genericSelectors, cosmetic, popup } = compile(LISTS, texts)

  for (const { id, rules } of rulesets) {
    await fs.writeFile(path.join(EXT, 'rules', `${id}.json`), JSON.stringify(rules))
  }
  await fs.writeFile(path.join(EXT, 'data', 'cosmetic-generic.css'), toCss(genericSelectors) + '\n')
  await fs.writeFile(path.join(EXT, 'data', 'cosmetic.json'), JSON.stringify(cosmetic))
  await fs.writeFile(path.join(EXT, 'data', 'popup.json'), JSON.stringify(popup))

  // Keep manifest's ruleset list in sync with LISTS.
  const manifestPath = path.join(EXT, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.declarative_net_request = { rule_resources: rulesets.map(({ id }) => ({ id, enabled: true, path: `rules/${id}.json` })) }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  console.table(Object.fromEntries(rulesets.map(r => [r.id, r.stats])))
  const total = rulesets.reduce((n, r) => n + r.stats.rules, 0)
  console.log(`network rules: ${total}  generic hiding: ${genericSelectors.length} (+${cosmetic.conditional.length} conditional)  ` +
    `site-specific domains: ${Object.keys(cosmetic.specific).length}  popup rules: ${popup.length}`)
}

main().catch(err => { console.error(err); process.exit(1) })
