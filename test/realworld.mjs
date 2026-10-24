// Loads a few real ad-heavy pages with and without the extension and screenshots both.
// Usage: node test/realworld.mjs [url ...]
import puppeteer from 'puppeteer'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')
const OUT = path.join(ROOT, 'test', 'out')
const urls = process.argv.slice(2).length ? process.argv.slice(2) : ['https://www.cnn.com/', 'https://www.dailymail.co.uk/home/index.html', 'https://www.yahoo.com/']
await fs.mkdir(OUT, { recursive: true })

async function run(withExt) {
  const browser = await puppeteer.launch({
    pipe: true,
    args: withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [],
    defaultViewport: { width: 1280, height: 900 },
  })
  if (withExt) await browser.waitForTarget(t => t.type() === 'service_worker')
  await new Promise(r => setTimeout(r, 1000))
  const out = {}
  for (const url of urls) {
    const page = await browser.newPage()
    let requests = 0, blocked = 0
    const errors = []
    page.on('request', () => requests++)
    page.on('requestfailed', r => { if (r.failure()?.errorText === 'net::ERR_BLOCKED_BY_CLIENT') blocked++ })
    page.on('pageerror', e => errors.push(e.message))
    const t0 = Date.now()
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(e => errors.push('goto: ' + e.message))
    const ms = Date.now() - t0
    await new Promise(r => setTimeout(r, 2000))
    const name = new URL(url).hostname.replace(/^www\./, '')
    await page.screenshot({ path: path.join(OUT, `real-${name}-${withExt ? 'on' : 'off'}.png`) })
    const iframes = await page.evaluate(() => document.querySelectorAll('iframe').length)
    out[name] = { requests, blocked, iframes, ms, pageErrors: errors.length }
    await page.close()
  }
  await browser.close()
  return out
}

const off = await run(false)
const on = await run(true)
const rows = {}
for (const k of Object.keys(on)) rows[k] = {
  'requests off→on': `${off[k].requests} → ${on[k].requests}`, blocked: on[k].blocked,
  'iframes off→on': `${off[k].iframes} → ${on[k].iframes}`, 'load ms off→on': `${off[k].ms} → ${on[k].ms}`,
  'page errors off→on': `${off[k].pageErrors} → ${on[k].pageErrors}`,
}
console.table(rows)
