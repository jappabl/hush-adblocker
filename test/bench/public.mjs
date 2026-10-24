// Public adblock test sites, head to head. Real network, real ad networks.
//   turtlecute     - "N blocked" out of 132 ad/tracker hosts
//   adblock-tester - "N points out of 100"
//   superadblocktest - "N blocked" out of 482 ad/tracker/telemetry checks
//   canyoublockit  - pages full of real ad formats: visible ad frames, ad requests, and what
//                    happens when you click ordinary parts of the page (popunders, redirects)
// Screenshots go to test/out/bench/. Usage: node test/bench/public.mjs [config ...]
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, CONFIGS } from './browsers.mjs'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../out/bench')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const CYBI = ['extreme-test', 'advanced-adblocker-test/pop-under-ads', 'advanced-adblocker-test/web-banners',
  'advanced-adblocker-test/native-ads', 'advanced-adblocker-test/push-notification-ads', 'advanced-adblocker-test/adblock-detector']

// Poll a page's text until a number stops changing (and nothing says "checking").
async function settledNumber(page, re, maxMs = 45000) {
  let prev = null, same = 0
  for (let t = 0; t < maxMs; t += 1500) {
    await sleep(1500)
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    const n = text.match(re)?.[1]
    if (n !== undefined && n === prev && !/checking…/.test(text)) { if (++same >= 3) return Number(n) } else same = 0
    prev = n
  }
  return prev === null ? null : Number(prev)
}

async function scoreSite(browser, url, re, shot) {
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  const n = await settledNumber(page, re)
  await page.screenshot({ path: path.join(OUT, shot) }).catch(() => {})
  await page.close()
  return n
}

async function superTest(browser, name) {
  const page = await browser.newPage()
  await page.goto('https://superadblocktest.com/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await (await page.evaluateHandle(() => [...document.querySelectorAll('button, a')].find(e => /start test/i.test(e.textContent)))).asElement()?.click()
  let n = null
  for (let i = 0; i < 40 && n === null; i++) {
    await sleep(1500)
    n = (await page.evaluate(() => document.body.innerText).catch(() => '')).match(/Completed: (\d+) blocked/)?.[1] ?? null
  }
  await page.screenshot({ path: path.join(OUT, `superadblocktest-${name}.png`) }).catch(() => {})
  await page.close()
  return n === null ? null : Number(n)
}

async function adPage(browser, name, slug) {
  const page = await browser.newPage()
  const origin = 'https://canyoublockit.com'
  let thirdParty = 0, blocked = 0
  page.on('requestfinished', r => { if (!r.url().startsWith(origin) && /^https?:/.test(r.url())) thirdParty++ })
  page.on('requestfailed', r => { if (r.failure()?.errorText === 'net::ERR_BLOCKED_BY_CLIENT') blocked++ })
  await page.goto(`${origin}/${slug}/`, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {})
  await sleep(6000)
  const tag = slug.split('/').pop()
  await page.screenshot({ path: path.join(OUT, `cybi-${tag}-${name}.png`), fullPage: true }).catch(() => {})
  const adFrames = await page.evaluate(() => [...document.querySelectorAll('iframe')].filter(f => {
    const r = f.getBoundingClientRect(), cs = getComputedStyle(f)
    return r.width * r.height > 2500 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.1
  }).length).catch(() => null)

  // Click three ordinary spots: the heading, a paragraph, and empty margin.
  const popups = [], redirects = []
  const onTarget = t => { if (t.type() === 'page') popups.push(t.url()) }
  browser.on('targetcreated', onTarget)
  const spots = await page.evaluate(() => {
    const at = el => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? [r.x + Math.min(r.width / 2, 200), r.y + Math.min(r.height / 2, 20)] : null }
    scrollTo(0, 0)
    return [at(document.querySelector('h1, h2')), at(document.querySelector('article p, .entry-content p, main p, p')), [30, 400]].filter(Boolean)
  }).catch(() => [])
  for (const [x, y] of spots) {
    if (page.isClosed()) break
    const before = page.url()
    await page.mouse.click(x, y).catch(() => {})
    await sleep(2500)
    if (!page.url().startsWith(origin)) { redirects.push(page.url()); await page.goBack().catch(() => {}); await sleep(1500) }
    else if (page.url() !== before && !page.url().startsWith(before.split('#')[0])) redirects.push(page.url())
  }
  browser.off('targetcreated', onTarget)
  for (const p of await browser.pages()) if (p !== page && !p.url().startsWith('about:blank')) await p.close().catch(() => {})
  await page.close().catch(() => {})
  return { adFrames, thirdParty, blocked, popups: popups.length, redirects: redirects.length, popupUrls: popups.slice(0, 3) }
}

export async function runPublic(configs = CONFIGS) {
  await fs.mkdir(OUT, { recursive: true })
  const results = {}
  for (const name of configs) {
    const browser = await launch(name)
    const r = results[name] = {}
    r.turtlecute = await scoreSite(browser, 'https://adblock.turtlecute.org/', /(\d+)\s+blocked/, `turtlecute-${name}.png`)
    r.adblockTester = await scoreSite(browser, 'https://adblock-tester.com/', /(\d+)\s+points out of 100/, `adblock-tester-${name}.png`)
    r.superTest = await superTest(browser, name)
    if (process.env.SCORES_ONLY) { await browser.close(); console.log(name, JSON.stringify(r)); continue }
    for (const slug of CYBI) r[slug.split('/').pop()] = await adPage(browser, name, slug).catch(e => ({ error: e.message }))
    await browser.close()
    console.log(name, JSON.stringify(r))
  }
  return results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configs = process.argv.slice(2).length ? process.argv.slice(2) : CONFIGS
  const results = await runPublic(configs)
  await fs.writeFile(path.join(OUT, 'public-results.json'), JSON.stringify(results, null, 2))
  const rows = {}
  for (const [name, r] of Object.entries(results)) {
    const pages = CYBI.map(s => r[s.split('/').pop()]).filter(p => p && !p.error)
    if (!pages.length) { rows[name] = { 'turtlecute /132': r.turtlecute, 'adblock-tester /100': r.adblockTester, 'superadblocktest /482': r.superTest }; continue }
    rows[name] = {
      'turtlecute /132': r.turtlecute, 'adblock-tester /100': r.adblockTester, 'superadblocktest /482': r.superTest,
      'ad frames visible': pages.reduce((n, p) => n + (p.adFrames ?? 0), 0),
      'ad-network requests': pages.reduce((n, p) => n + p.thirdParty, 0),
      'popups on 18 clicks': pages.reduce((n, p) => n + p.popups, 0),
      'redirects on 18 clicks': pages.reduce((n, p) => n + p.redirects, 0),
    }
  }
  console.table(rows)
}
