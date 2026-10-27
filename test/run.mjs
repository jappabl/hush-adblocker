// End-to-end tests: real Chrome (Chrome for Testing via puppeteer) with the extension loaded,
// against a local server that impersonates normal sites, ad servers and hijacking pages.
// Every hostname resolves to 127.0.0.1 (--host-resolver-rules), so no real site is contacted.
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')
const OUT = path.join(ROOT, 'test', 'out')
const PORT = 8099
const LIST_COUNT = JSON.parse(await fs.readFile(path.join(EXT, 'manifest.json'), 'utf8')).declarative_net_request.rule_resources.length
const TLS_PORT = 8443 // youtube.com is HTTPS-only (HSTS preload), so its fixture needs TLS
const u = (host, p = '/') => `http://${host}:${PORT}${p}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- fixture pages ----------
const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}
<style>body{font:15px system-ui;margin:40px}button,a{font:inherit}</style></head><body>${body}</body></html>`

const FIXTURES = {
  '/ads': page(`
    <h1>Article</h1>
    <div class="ad_unit" id="generic-ad" style="height:90px;background:#fc0">AD</div>
    <div id="content">Real content</div>
    <script>
      window.results = {}
      const load = (k, src) => { const s = document.createElement('script'); s.src = src
        s.onload = () => results[k] = 'loaded'; s.onerror = () => results[k] = 'blocked'; document.head.append(s) }
      load('adScript', '${u('pagead2.googlesyndication.com', '/pagead/js/adsbygoogle.js')}')
      load('tracker', '${u('www.google-analytics.com', '/analytics.js')}')
      load('ownScript', '/app.js')
    </script>`),
  '/specific': page(`<div id="ad__banner" style="height:50px;background:#fc0">site ad slot</div><div id="keep">keep</div>`),
  '/popunder': page(`
    <p id="text">Click anywhere on this page.</p>
    <a id="ext" target="_blank" href="${u('other.test', '/ext')}">External link</a>
    <button id="share" onclick="window.open('${u('x.com', '/intent/tweet')}', '_blank', 'width=500,height=400')">Share</button>
    <script>
      document.addEventListener('click', e => {
        if (e.target.id === 'ext' || e.target.id === 'share') return
        window.open('${u('evil.test', '/landing')}')
      })
    </script>`),
  '/hijack': page(`
    <a id="lnk" href="/page2">Episode 2</a>
    <script>
      document.addEventListener('click', e => { e.preventDefault(); location.href = '${u('evil.test', '/scam')}' })
    </script>`),
  '/hijack-any': page(`
    <p id="text">Some article text.</p>
    <script>document.addEventListener('click', () => { location.href = '${u('evil.test', '/scam')}' })</script>`),
  '/synthetic': page(`
    <p id="text">Click me</p>
    <script>
      document.addEventListener('click', () => {
        const a = document.createElement('a'); a.href = '${u('evil.test', '/pop')}'; a.target = '_blank'; a.click()
      })
    </script>`),
  '/overlay': page(`
    <button id="real" onclick="document.title='real clicked'">Play</button>
    <a id="ov" href="${u('evil.test', '/ov')}" target="_blank" style="position:fixed;inset:0;z-index:99"></a>`),
  '/timed': page(`<p>Reading…</p><script>setTimeout(() => location.href = '${u('evil.test', '/timed')}', 3500)</script>`),
  '/meta': page(`<p>Reading…</p><script>setTimeout(() => {
      const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${u('evil.test', '/meta')}'
      document.head.append(m) }, 3500)</script>`),
  '/redir': page(`<script>location.replace('${u('other.test', '/dest')}')</script>`),
  '/button': page(`<button id="btn" onclick="location.href='${u('other.test', '/checkout')}'">Checkout</button>`),
  '/fresh': page(`
    <div class="hush-fresh-ad" id="fresh-ad" style="height:60px;background:#fc0">new kind of ad</div>
    <a id="fresh-pop" target="_blank" href="${u('fresh-popunder.test', '/')}">link</a>
    <script>
      window.results = {}
      const s = document.createElement('script'); s.src = '${u('fresh-ad-network.test', '/ads.js')}'
      s.onload = () => results.fresh = 'loaded'; s.onerror = () => results.fresh = 'blocked'; document.head.append(s)
    </script>`),
  '/listed-popup': page(`<a id="pl" target="_blank" href="${u('0i0i0i0.com', '/')}">Totally normal link</a>`),
}

// Filter list mirror for the auto-update tests: the real lists (from the build cache) with
// three rules that the packaged lists don't have. /broken/ serves an error page for EasyList.
const LIST_EXTRAS = '\n||fresh-ad-network.test^\n##.hush-fresh-ad\n||fresh-popunder.test^$popup\n'
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0]
  const list = p.match(/^\/(lists|broken)\/([\w.-]+\.txt)$/)
  if (list) {
    if (list[1] === 'broken' && list[2] === 'easylist.txt') { res.writeHead(200); return res.end('<html>Service unavailable</html>') }
    const text = await fs.readFile(path.join(ROOT, '.cache', list[2]), 'utf8')
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(list[2] === 'easylist.txt' ? text + LIST_EXTRAS : text)
  }
  if (p.endsWith('.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('/* ok */') }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(FIXTURES[p] ?? page(`<h1>${req.headers.host}${p}</h1>`))
})
await new Promise(r => server.listen(PORT, r))

// Fake YouTube: the ad data the real site sends, in each place the player reads it.
const AD_JSON = '{"adPlacements":[{"a":1}],"adSlots":[{"a":1}],"playerAds":[{"a":1}],"videoDetails":{"videoId":"x"}}'
const YT_PAGE = page(`
  <div id="movie_player"><video id="v" src="/ad.mp4" muted autoplay loop></video>
    <button class="ytp-skip-ad-button" onclick="r.skipClicked = true">Skip</button></div>
  <script>var ytInitialPlayerResponse = ${AD_JSON};</script>
  <script>
    window.r = {}
    const keys = o => Object.keys(o).sort().join()
    r.initial = keys(ytInitialPlayerResponse)
    r.parse = keys(JSON.parse('{"playerResponse":${AD_JSON.replace(/"/g, '\\"')}}').playerResponse)
    r.shorts = JSON.parse('{"entries":[{"command":{"reelWatchEndpoint":{"adClientParams":{"isAd":true}}}},{"command":{"reelWatchEndpoint":{}}}]}').entries.length
    r.looksNative = String(fetch).includes('[native code]') && String(JSON.parse).includes('[native code]')
    ;(async () => {
      r.fetch = await (await fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST' })).text()
      const x = new XMLHttpRequest()
      x.open('POST', '/youtubei/v1/player')
      x.onload = () => { r.xhr = x.responseText }
      x.send()
      // YouTube's trick: pristine functions from a fresh iframe.
      document.body.appendChild(document.createElement('iframe'))
      const fresh = frames[frames.length - 1]
      r.iframeFetch = await (await fresh.fetch('/youtubei/v1/player')).text()
      r.iframeParse = keys(fresh.JSON.parse('${AD_JSON}'))
      const t0 = performance.now()
      setTimeout(Function.prototype.call.bind(() => { r.timerMs = Math.round(performance.now() - t0) }), 17000)
    })()
  </script>`)

const certDir = path.join(OUT, 'tls')
await fs.mkdir(certDir, { recursive: true })
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=www.youtube.com',
  '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' })
const adVideo = path.join(OUT, 'ad.mp4')
await fs.access(adVideo).catch(() => execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x180:rate=15',
  '-pix_fmt', 'yuv420p', adVideo], { stdio: 'ignore' }))
const tlsServer = https.createServer({ key: await fs.readFile(path.join(certDir, 'key.pem')), cert: await fs.readFile(path.join(certDir, 'cert.pem')) }, async (req, res) => {
  const p = req.url.split('?')[0]
  if (p === '/ad.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(await fs.readFile(adVideo)) }
  if (p.startsWith('/youtubei/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(AD_JSON) }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(YT_PAGE)
})
await new Promise(r => tlsServer.listen(TLS_PORT, r))
const yt = (p = '/watch?v=x') => `https://www.youtube.com:${TLS_PORT}${p}`

// ---------- browser ----------
const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--host-resolver-rules=MAP * 127.0.0.1',
    '--ignore-certificate-errors',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    '--window-size=1100,800',
  ],
  defaultViewport: { width: 1100, height: 800 },
})
await fs.mkdir(OUT, { recursive: true })

const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'))
const sw = await swTarget.worker()
const extId = new URL(swTarget.url()).host
// Wait until content scripts are registered (onInstalled -> apply()).
for (let i = 0; i < 50; i++) {
  if ((await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length === 4) break
  await sleep(100)
}

const results = []
async function test(name, fn) {
  const tab = await browser.newPage()
  try {
    await fn(tab)
    results.push([name, 'ok'])
    console.log('  ✓', name)
  } catch (err) {
    results.push([name, 'FAIL', err.message])
    console.log('  ✗', name, '\n     ', err.message)
    await tab.screenshot({ path: path.join(OUT, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
  } finally {
    await tab.close().catch(() => {})
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

// Pages opened from `tab` within `ms` after `action`.
async function popupsDuring(tab, action, ms = 1500) {
  const seen = []
  const onTarget = t => { if (t.opener() === tab.target()) seen.push(t.url()) }
  browser.on('targetcreated', onTarget)
  await action()
  await sleep(ms)
  browser.off('targetcreated', onTarget)
  return seen
}
const noticeShown = tab => tab.evaluate(() => !!document.querySelector('hush-notice'))
const openTabUrls = async () => (await browser.pages()).map(p => p.url())

console.log('\nextension', extId)
const rulesets = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())
console.log('enabled rulesets:', rulesets.join(', '))

await test('all filter rulesets are enabled', async () => {
  assert(rulesets.length === LIST_COUNT, `only ${rulesets.length} of ${LIST_COUNT} enabled`)
})

await test('ad + tracker scripts blocked, own script loads', async tab => {
  await tab.goto(u('news.test', '/ads'))
  await tab.waitForFunction(() => Object.keys(results).length === 3, { timeout: 5000 })
  const r = await tab.evaluate(() => results)
  assert(r.adScript === 'blocked', `ad script ${r.adScript}`)
  assert(r.tracker === 'blocked', `tracker ${r.tracker}`)
  assert(r.ownScript === 'loaded', `own script ${r.ownScript}`)
})

await test('generic ad element hidden', async tab => {
  await tab.goto(u('news.test', '/ads'))
  const d = await tab.$eval('#generic-ad', el => getComputedStyle(el).display)
  assert(d === 'none', `display is ${d}`)
  await tab.screenshot({ path: path.join(OUT, 'ads.png') })
})

await test('site-specific ad element hidden', async tab => {
  await tab.goto(u('www.travelm.de', '/specific'))
  await tab.waitForFunction(() => getComputedStyle(document.getElementById('ad__banner')).display === 'none', { timeout: 3000 })
  const keep = await tab.$eval('#keep', el => getComputedStyle(el).display)
  assert(keep !== 'none', 'unrelated element was hidden')
})

await test('click-anywhere popunder blocked, notice shown', async tab => {
  await tab.goto(u('site.test', '/popunder'))
  const pops = await popupsDuring(tab, () => tab.click('#text'))
  assert(pops.length === 0, `popup opened: ${pops}`)
  assert(await noticeShown(tab), 'no notice')
  await sleep(300)
  await tab.screenshot({ path: path.join(OUT, 'notice-popup.png') })
})

await test('real target=_blank link still opens', async tab => {
  await tab.goto(u('site.test', '/popunder'))
  const pops = await popupsDuring(tab, () => tab.click('#ext'))
  assert(pops.some(p => p.includes('other.test')), `opened: ${JSON.stringify(pops)}`)
  assert(!pops.some(p => p.includes('evil.test')), 'evil popup opened too')
})

await test('share button popup to x.com still opens', async tab => {
  await tab.goto(u('site.test', '/popunder'))
  const pops = await popupsDuring(tab, () => tab.click('#share'))
  assert(pops.some(p => p.includes('x.com')), `opened: ${JSON.stringify(pops)}`)
})

await test('link hijacked to another site: blocked, and the real link opens on the first click', async tab => {
  await tab.goto(u('site.test', '/hijack'))
  await tab.click('#lnk')
  await sleep(1200)
  assert(tab.url() === u('site.test', '/page2'), `ended at ${tab.url()}`)
})

await test('click-anywhere redirect blocked, notice shown', async tab => {
  await tab.goto(u('site.test', '/hijack-any'))
  await tab.click('#text')
  await sleep(1200)
  assert(tab.url().startsWith(u('site.test')), `navigated to ${tab.url()}`)
  assert(await noticeShown(tab), 'no notice')
  await tab.screenshot({ path: path.join(OUT, 'notice-redirect.png') })
})

await test('"Go anyway" continues to the blocked destination', async tab => {
  await tab.goto(u('site.test', '/hijack-any'))
  await tab.click('#text')
  await sleep(600)
  const box = await tab.$eval('hush-notice', el => { const r = el.getBoundingClientRect(); return { r: r.right, y: r.top + r.height / 2 } })
  await Promise.all([tab.waitForNavigation({ timeout: 4000 }), tab.mouse.click(box.r - 70, box.y)])
  assert(tab.url().startsWith(u('evil.test')), `ended at ${tab.url()}`)
})

await test('scripted target=_blank click blocked', async tab => {
  await tab.goto(u('site.test', '/synthetic'))
  const pops = await popupsDuring(tab, () => tab.click('#text'))
  assert(pops.length === 0, `popup opened: ${pops}`)
})

await test('invisible overlay link blocked, then clicks reach the page', async tab => {
  await tab.goto(u('site.test', '/overlay'))
  const pops = await popupsDuring(tab, () => tab.mouse.click(60, 60))
  assert(pops.length === 0, `popup opened: ${pops}`)
  await tab.click('#real')
  assert(await tab.title() === 'real clicked', 'underlying button did not get the click')
})

await test('timed redirect (no click) blocked', async tab => {
  await tab.goto(u('site.test', '/timed'))
  await sleep(4500)
  assert(tab.url().startsWith(u('site.test')), `navigated to ${tab.url()}`)
})

await test('delayed meta refresh blocked', async tab => {
  await tab.goto(u('site.test', '/meta'))
  await sleep(4500)
  assert(tab.url().startsWith(u('site.test')), `navigated to ${tab.url()}`)
})

await test('instant redirect page (link shortener) allowed', async tab => {
  await tab.goto(u('short.test', '/redir'))
  await tab.waitForFunction(() => location.hostname === 'other.test', { timeout: 4000 })
})

await test('button that goes to another site allowed', async tab => {
  await tab.goto(u('shop.test', '/button'))
  await Promise.all([tab.waitForNavigation({ timeout: 4000 }), tab.click('#btn')])
  assert(tab.url().startsWith(u('other.test')), `ended at ${tab.url()}`)
})

await test('popup to known popunder network closed by background', async tab => {
  await tab.goto(u('site.test', '/listed-popup'))
  await tab.click('#pl')
  await sleep(2000)
  const urls = await openTabUrls()
  assert(!urls.some(x => x.includes('0i0i0i0.com')), `still open: ${urls}`)
  assert(await noticeShown(tab), 'no notice')
})

await test('YouTube: ad data stripped everywhere the player reads it', async tab => {
  await tab.goto(yt())
  await tab.waitForFunction(() => r.xhr && r.iframeFetch, { timeout: 5000 })
  const r = await tab.evaluate(() => r)
  assert(r.initial === 'videoDetails', `inline response kept: ${r.initial}`)
  assert(r.parse === 'videoDetails', `JSON.parse kept: ${r.parse}`)
  for (const k of ['fetch', 'xhr', 'iframeFetch']) assert(!/adPlacements|adSlots|playerAds/.test(r[k]), `${k} kept ads: ${r[k]}`)
  assert(r.iframeParse === 'videoDetails', `iframe JSON.parse kept: ${r.iframeParse}`)
  assert(r.shorts === 1, `Shorts ad entry kept (${r.shorts} entries)`)
  assert(r.looksNative, 'patched functions do not look native')
})

await test('YouTube: 17 s ad-blocker start delay removed', async tab => {
  await tab.goto(yt())
  await tab.waitForFunction(() => r.timerMs !== undefined, { timeout: 5000 })
})

await test('YouTube: an ad that still plays is skipped, muted and sped up, then restored', async tab => {
  await tab.goto(yt())
  await tab.evaluate(() => { document.getElementById('v').muted = false; document.getElementById('movie_player').classList.add('ad-showing') })
  await sleep(800)
  const during = await tab.evaluate(() => { const v = document.getElementById('v'); return { rate: v.playbackRate, muted: v.muted, skip: !!r.skipClicked } })
  assert(during.rate === 16 && during.muted && during.skip, `during ad: ${JSON.stringify(during)}`)
  await tab.evaluate(() => document.getElementById('movie_player').classList.remove('ad-showing'))
  await sleep(800)
  const after = await tab.evaluate(() => { const v = document.getElementById('v'); return { rate: v.playbackRate, muted: v.muted } })
  assert(after.rate === 1 && !after.muted, `after ad: ${JSON.stringify(after)}`)
})

await test('YouTube: "ad blockers are not allowed" dialog removed', async tab => {
  await tab.goto(yt())
  await tab.evaluate(() => document.body.insertAdjacentHTML('beforeend',
    '<tp-yt-paper-dialog id="wall"><ytd-enforcement-message-view-model>Ad blockers are not allowed on YouTube</ytd-enforcement-message-view-model></tp-yt-paper-dialog>'))
  await sleep(300)
  assert(!(await tab.$('#wall')), 'dialog still present')
})

await test('pausing redirects on a site lets its popups through', async tab => {
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ pausedGuard: ['site.test'] })
    await apply()
  })
  await tab.goto(u('site.test', '/popunder'))
  const pops = await popupsDuring(tab, () => tab.click('#text'))
  await sw.evaluate(async () => { await chrome.storage.local.set({ pausedGuard: [] }); await apply() })
  assert(pops.some(p => p.includes('evil.test')), `popup not opened when paused: ${pops}`)
})

await test('pausing ads on a site lets its ads load', async tab => {
  await sw.evaluate(async () => { await chrome.storage.local.set({ pausedAds: ['news.test'] }); await apply() })
  await tab.goto(u('news.test', '/ads'))
  await tab.waitForFunction(() => Object.keys(results).length === 3, { timeout: 5000 })
  const r = await tab.evaluate(() => results)
  const d = await tab.$eval('#generic-ad', el => getComputedStyle(el).display)
  await sw.evaluate(async () => { await chrome.storage.local.set({ pausedAds: [] }); await apply() })
  assert(r.adScript === 'loaded', `ad script ${r.adScript}`)
  assert(d !== 'none', 'ad still hidden')
})

const mirror = dir => `HushCompiler.LISTS.map(l => (l.local ? l : { ...l, url: 'http://lists.test:${PORT}/${dir}/' + l.file }))`

await test('broken list download leaves the packaged lists in place', async () => {
  const err = await sw.evaluate(`updateLists(${mirror('broken')}).then(() => null, e => e.message)`)
  assert(err?.includes('easylist'), `update did not refuse: ${err}`)
  const enabled = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())
  const dyn = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then(r => r.length))
  assert(enabled.length === LIST_COUNT && dyn === 0, `state changed: ${enabled.length} rulesets, ${dyn} dynamic rules`)
})

await test('filter lists update in the background: new rules apply without a rebuild', async tab => {
  const before = await tab.goto(u('news.test', '/fresh')).then(() => tab.waitForFunction(() => results.fresh, { timeout: 5000 })).then(() => tab.evaluate(() => results.fresh))
  assert(before === 'loaded', `new ad server already blocked before update (${before})`)
  const t0 = Date.now()
  const outcome = await sw.evaluate(`updateLists(${mirror('lists')})`)
  console.log(`      update took ${Date.now() - t0} ms`)
  assert(outcome === 'updated', outcome)
  const enabled = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())
  const dyn = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then(r => r.length))
  const packaged = await sw.evaluate(async () => {
    let n = 0
    for (const { path } of chrome.runtime.getManifest().declarative_net_request.rule_resources) n += (await (await fetch(path)).json()).length
    return n
  })
  assert(enabled.length === 0 && Math.abs(dyn - packaged) < packaged * 0.1, `${enabled.length} packaged rulesets still on, ${dyn} dynamic rules (packaged: ${packaged})`)

  await tab.goto(u('news.test', '/fresh'))
  await tab.waitForFunction(() => results.fresh, { timeout: 5000 })
  assert(await tab.evaluate(() => results.fresh) === 'blocked', 'new ad server not blocked')
  await tab.waitForFunction(() => getComputedStyle(document.getElementById('fresh-ad')).display === 'none', { timeout: 3000 })
  await tab.click('#fresh-pop')
  await sleep(2000)
  assert(!(await openTabUrls()).some(x => x.includes('fresh-popunder.test')), 'new popunder network not closed')

  // Old protections still in place on the updated lists.
  await tab.goto(u('news.test', '/ads'))
  await tab.waitForFunction(() => Object.keys(results).length === 3, { timeout: 5000 })
  const r = await tab.evaluate(() => results)
  assert(r.adScript === 'blocked' && r.ownScript === 'loaded', JSON.stringify(r))
  assert(await tab.$eval('#generic-ad', el => getComputedStyle(el).display) === 'none', 'generic hiding lost')

  assert(await sw.evaluate(`updateLists(${mirror('lists')})`) === 'unchanged', 'second update was not a no-op')
})

await test('toolbar popup renders', async tab => {
  // Make the popup think the active tab is the ad page.
  const site = await browser.newPage()
  await site.goto(u('news.test', '/ads'))
  await sleep(800)
  const siteTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://news.test/*' }))[0].id)
  await tab.evaluateOnNewDocument(id => {
    chrome.tabs.query = async () => [await chrome.tabs.get(id)]
  }, siteTabId)
  await tab.setViewport({ width: 260, height: 210, deviceScaleFactor: 2 })
  await tab.goto(`chrome-extension://${extId}/popup.html`)
  await sleep(300)
  const text = await tab.evaluate(() => document.body.innerText)
  await tab.screenshot({ path: path.join(OUT, 'popup.png'), clip: await tab.$eval('body', b => { const r = b.getBoundingClientRect(); return { x: 0, y: 0, width: r.width, height: r.height } }) })
  const badge = await sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), siteTabId)
  await site.close()
  assert(text.includes('news.test') && text.includes('2 requests blocked') && text.includes('Filter lists updated'), text)
  assert(/[\d,]+ blocked since install/.test(text), `no lifetime total: ${text}`)
  assert(badge === '2', `toolbar badge shows "${badge}", popup says 2`)
})

await browser.close()
server.close()
tlsServer.close()
const failed = results.filter(r => r[1] !== 'ok')
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
