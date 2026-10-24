// Real-site hijack test: for each site, click the things a reader clicks (a paragraph, a heading,
// blank margin, then one of the site's own links) and count what happens that they didn't ask for:
// new tabs, and redirects to other sites. Also checks that the site's own link works first time.
// Downloads are denied. Run `none` first: only sites that hijack plain Chrome say anything.
//
// Usage: node test/bench/wild.mjs <sites-file> [config ...]
//   sites file: one URL per line, `#` comments allowed.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, CONFIGS } from './browsers.mjs'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../out/wild')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const siteOf = h => h.split('.').slice(-2).join('.')
const sameSite = (a, b) => { try { return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname) } catch { return false } }

async function visit(browser, url, name) {
  const page = await browser.newPage()
  const r = { popups: [], redirects: [], link: 'n/a' }
  const onTarget = t => { if (t.type() === 'page') r.popups.push(t.url() || '(blank)') }
  const settle = async () => {
    for (const p of await browser.pages()) if (p !== page && !p.url().startsWith('about:blank')) await p.close().catch(() => {})
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch (e) {
    await page.close().catch(() => {})
    return { error: e.message.split('\n')[0].slice(0, 60) }
  }
  await sleep(5000)
  const home = page.url()
  await page.screenshot({ path: path.join(OUT, `${new URL(url).hostname}-${name}.png`) }).catch(() => {})

  const back = async () => {
    if (!sameSite(page.url(), home)) {
      r.redirects.push(page.url())
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await sleep(3000)
    }
  }
  const spot = sel => page.evaluate(sel => {
    const vis = e => { const b = e.getBoundingClientRect(); return b.width > 30 && b.height > 8 && b.top > 60 && b.bottom < innerHeight - 10 }
    const el = [...document.querySelectorAll(sel)].find(vis)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return [b.x + Math.min(b.width / 2, 150), b.y + Math.min(b.height / 2, 12)]
  }, sel).catch(() => null)

  browser.on('targetcreated', onTarget)
  for (const sel of ['p, li, td', 'h1, h2, h3', null]) {
    const at = sel ? await spot(sel) : [12, 450]
    if (!at) continue
    await page.mouse.click(...at).catch(() => {})
    await sleep(3000)
    await back()
  }
  // Use the site: paste a video link into its search/URL box and submit, then press its main button.
  const box = await page.evaluate(() => {
    const vis = e => { const b = e.getBoundingClientRect(); return b.width > 80 && b.height > 15 && b.top > 0 && b.bottom < innerHeight }
    const i = [...document.querySelectorAll('input[type=text], input[type=search], input[type=url], input:not([type])')].find(vis)
    if (!i) return null
    const b = i.getBoundingClientRect()
    return [b.x + b.width / 2, b.y + b.height / 2]
  }).catch(() => null)
  if (box) {
    await page.mouse.click(...box).catch(() => {})
    await page.keyboard.type('https://www.youtube.com/watch?v=dQw4w9WgXcQ').catch(() => {})
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(4000)
    await back()
    const button = await spot('button, input[type=submit], [role=button], .btn, [class*=button]')
    if (button) { await page.mouse.click(...button).catch(() => {}); await sleep(4000); await back() }
  }
  // One of the site's own links: does the first click go where it points?
  const link = await page.evaluate(home => {
    const site = h => h.split('.').slice(-2).join('.')
    const ok = a => {
      const b = a.getBoundingClientRect()
      try {
        const u = new URL(a.href)
        return b.width > 20 && b.height > 8 && b.top > 60 && b.bottom < innerHeight - 10 && a.target !== '_blank' &&
          site(u.hostname) === site(location.hostname) && u.pathname !== location.pathname && !u.hash && a.innerText.trim().length > 2
      } catch { return false }
    }
    const a = [...document.querySelectorAll('a[href]')].find(ok)
    if (!a) return null
    const b = a.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, href: a.href }
  }, home).catch(() => null)
  if (link) {
    await page.mouse.click(link.x, link.y).catch(() => {})
    await sleep(3500)
    const at = page.url()
    r.link = at.split('#')[0] === link.href.split('#')[0] ? 'ok' : sameSite(at, home) ? `stayed (${at === home ? 'needed another click' : at})` : 'hijacked'
    await back()
  }
  browser.off('targetcreated', onTarget)
  // Pop-ups to the site itself from its own link don't count; everything else does.
  r.popups = r.popups.filter(u => !(link && u.split('#')[0] === link.href.split('#')[0]))
  await settle()
  await page.close().catch(() => {})
  return r
}

const [file, ...rest] = process.argv.slice(2)
if (!file) { console.log('usage: node test/bench/wild.mjs <sites-file> [config ...]'); process.exit(1) }
const sites = (await fs.readFile(file, 'utf8')).split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
const configs = rest.length ? rest : CONFIGS
await fs.mkdir(OUT, { recursive: true })

const results = {}
for (const name of configs) {
  const browser = await launch(name)
  const cdp = await browser.target().createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
  for (const url of sites) {
    const r = await visit(browser, url, name).catch(e => ({ error: e.message.slice(0, 60) }))
    ;(results[url] ??= {})[name] = r
    const brief = r.error ? `error: ${r.error}` : `popups ${r.popups.length}, redirects ${r.redirects.length}, own link: ${r.link}`
    console.log(`${name.padEnd(8)} ${url}  ${brief}${r.popups?.length ? '  [' + r.popups.slice(0, 2).join(' ') + ']' : ''}${r.redirects?.length ? '  → ' + r.redirects[0] : ''}`)
  }
  await browser.close()
}
await fs.writeFile(path.join(OUT, `results-${path.basename(file)}.json`), JSON.stringify(results, null, 2))

// Only sites that hijacked plain Chrome tell us anything.
const hijackers = sites.filter(u => { const n = results[u]?.none; return n && !n.error && (n.popups.length || n.redirects.length || n.link === 'hijacked') })
const rows = {}
for (const name of configs) {
  let pop = 0, red = 0, clean = 0, linkOk = 0, linkTried = 0
  for (const u of hijackers) {
    const r = results[u][name]
    if (!r || r.error) continue
    pop += r.popups.length; red += r.redirects.length
    if (!r.popups.length && !r.redirects.length && r.link !== 'hijacked') clean++
    if (r.link !== 'n/a') { linkTried++; if (r.link === 'ok') linkOk++ }
  }
  rows[name] = { 'clean visits': `${clean}/${hijackers.length}`, 'unwanted tabs': pop, 'unwanted redirects': red, 'own link worked first click': `${linkOk}/${linkTried}` }
}
console.log(`\n${hijackers.length} of ${sites.length} sites hijacked plain Chrome:`)
console.table(rows)
