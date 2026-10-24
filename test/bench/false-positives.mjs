// False-positive crawl: mainstream sites with no click hijacking. Hush should never intervene
// here, so every popup/redirect it blocks is a mistake. Clicks only links and empty space
// (no forms, no buttons that could change anything), in a fresh profile, not signed in.
// Usage: node test/bench/false-positives.mjs
import { launch } from './browsers.mjs'

const SITES = ['https://www.google.com/search?q=weather', 'https://en.wikipedia.org/wiki/Web_browser', 'https://www.bbc.com/news',
  'https://www.nytimes.com/', 'https://github.com/', 'https://stackoverflow.com/questions', 'https://www.reddit.com/r/news/',
  'https://www.amazon.com/', 'https://www.ebay.com/', 'https://www.imdb.com/', 'https://www.espn.com/', 'https://www.cnn.com/',
  'https://www.theguardian.com/international', 'https://www.weather.com/', 'https://www.booking.com/', 'https://www.etsy.com/',
  'https://www.walmart.com/', 'https://news.ycombinator.com/', 'https://www.twitch.tv/', 'https://www.spotify.com/',
  'https://www.apple.com/', 'https://www.microsoft.com/', 'https://www.paypal.com/', 'https://duckduckgo.com/?q=weather',
  'https://www.bing.com/search?q=weather']
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await launch('hush')
const found = []
let clicks = 0
for (const url of SITES) {
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    addEventListener('__hush_blocked', e => { (window.__hushLog ??= []).push(String(e.detail)) })
  })
  const log = async () => page.evaluate(() => window.__hushLog?.splice(0) ?? []).catch(() => [])
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)
    for (const l of await log()) found.push(`${url} (on load): ${l}`)
    // Two empty-space clicks, then up to three visible links (each followed, then back).
    for (const [x, y] of [[20, 500], [1260, 300]]) {
      await page.mouse.click(x, y).catch(() => {}); clicks++; await sleep(1200)
      for (const l of await log()) found.push(`${url} (empty-space click): ${l}`)
      if (page.url().split('#')[0] !== url.split('#')[0]) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    for (let i = 0; i < 3; i++) {
      const spot = await page.evaluate(i => {
        const links = [...document.querySelectorAll('a[href^="http"], a[href^="/"]')].filter(a => {
          const r = a.getBoundingClientRect()
          return r.width > 20 && r.height > 8 && r.top > 80 && r.bottom < innerHeight - 20 && a.innerText.trim().length > 3 && !a.closest('form')
        })
        const a = links[i * 3]
        if (!a) return null
        const r = a.getBoundingClientRect()
        return [r.x + r.width / 2, r.y + r.height / 2, a.href]
      }, i).catch(() => null)
      if (!spot) break
      const before = page.url()
      await page.mouse.click(spot[0], spot[1]).catch(() => {}); clicks++
      await sleep(2500)
      for (const l of await log()) found.push(`${url} (link ${spot[2]}): ${l}`)
      if (page.url() !== before) { await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(2000) }
    }
  } catch (e) {
    console.log('skip', url, e.message.slice(0, 60))
  }
  for (const p of await browser.pages()) if (p !== page && !p.url().startsWith('about:blank')) await p.close().catch(() => {})
  await page.close().catch(() => {})
}
await browser.close()
console.log(`${SITES.length} sites, ${clicks} clicks, ${found.length} interventions`)
found.forEach(f => console.log('  ' + f))
