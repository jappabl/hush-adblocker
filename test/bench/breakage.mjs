// Breakage check: mainstream sites with and without Hush. Flags a site when, with Hush, the page
// shows much less text, an image-heavy page loses most of its images, new script errors appear,
// or the page retries a blocked request in a loop (>50 times).
// Screenshots of flagged sites go to test/out/breakage/ for a look.
// Usage: node test/bench/breakage.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './browsers.mjs'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../out/breakage')
const SITES = ['https://www.google.com/search?q=weather', 'https://en.wikipedia.org/wiki/Web_browser', 'https://www.bbc.com/news',
  'https://www.nytimes.com/', 'https://github.com/', 'https://stackoverflow.com/questions', 'https://www.amazon.com/',
  'https://www.imdb.com/', 'https://www.espn.com/', 'https://www.cnn.com/', 'https://www.theguardian.com/international',
  'https://weather.com/', 'https://www.booking.com/', 'https://www.etsy.com/', 'https://www.walmart.com/',
  'https://news.ycombinator.com/', 'https://www.spotify.com/', 'https://www.apple.com/', 'https://www.microsoft.com/',
  'https://www.paypal.com/', 'https://duckduckgo.com/?q=weather', 'https://www.bing.com/search?q=weather',
  'https://www.youtube.com/', 'https://www.netflix.com/', 'https://www.linkedin.com/', 'https://www.instagram.com/',
  'https://www.target.com/', 'https://www.nike.com/', 'https://www.airbnb.com/', 'https://www.zillow.com/']
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function measure(name) {
  const browser = await launch(name)
  const out = {}
  for (const url of SITES) {
    const page = await browser.newPage()
    const errors = new Set()
    const blockedByUrl = {}
    page.on('pageerror', e => errors.add(e.message.slice(0, 120)))
    page.on('requestfailed', r => { if (r.failure()?.errorText === 'net::ERR_BLOCKED_BY_CLIENT') { const u = r.url().split('?')[0]; blockedByUrl[u] = (blockedByUrl[u] ?? 0) + 1 } })
    let status = null
    try {
      const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
      status = res?.status() ?? null
      await sleep(2500)
      const m = await page.evaluate(() => ({
        text: document.body?.innerText.length ?? 0,
        images: [...document.images].filter(i => i.complete && i.naturalWidth > 50).length,
      }))
      const storm = Object.entries(blockedByUrl).sort((a, b) => b[1] - a[1])[0]
      out[url] = { status, ...m, errors: [...errors], storm: storm && storm[1] > 50 ? `${storm[0].slice(0, 80)} ×${storm[1]}` : null }
      await page.screenshot({ path: path.join(OUT, `${new URL(url).hostname}-${name}.png`) }).catch(() => {})
    } catch (e) {
      out[url] = { status, error: e.message.slice(0, 80) }
    }
    await page.close().catch(() => {})
  }
  await browser.close()
  return out
}

await fs.mkdir(OUT, { recursive: true })
const plain = await measure('none')
const hush = await measure('hush')
const flagged = []
for (const url of SITES) {
  const a = plain[url], b = hush[url]
  if (!a?.text || !b) continue
  const why = []
  if (b.text < a.text * 0.6) why.push(`text ${a.text} → ${b.text}`)
  if (a.images >= 5 && b.images < a.images * 0.4) why.push(`images ${a.images} → ${b.images}`)
  if (b.storm) why.push(`retry storm: ${b.storm}`)
  const newErrors = b.errors.filter(e => !a.errors.includes(e))
  if (newErrors.length) why.push(`new errors: ${newErrors.join(' | ')}`)
  if (why.length) flagged.push(`${url}: ${why.join('; ')}`)
}
console.log(`${SITES.length} sites compared, ${flagged.length} flagged`)
flagged.forEach(f => console.log('  ' + f))
