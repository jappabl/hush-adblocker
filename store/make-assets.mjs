// Renders the Chrome Web Store images from the real extension on local demo pages:
//   store/screenshots/1-redirects.png, 2-ads.png, 3-popup.png (1280x800), store/promo-440x280.png,
//   store/hero-1280x640.png (README / social preview)
// Usage: node store/make-assets.mjs
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from '../test/bench/browsers.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(DIR, 'screenshots')
const PORT = 8066
const sleep = ms => new Promise(r => setTimeout(r, ms))
await fs.mkdir(OUT, { recursive: true })

// ---------- demo pages ----------
const css = `body{margin:0;font:16px/1.55 Georgia,serif;color:#1d1d1f;background:#fff}
header{font:700 22px system-ui;padding:16px 40px;border-bottom:1px solid #eee}
main{max-width:680px;margin:28px auto;padding:0 24px}h1{font:700 34px/1.2 system-ui;margin:0 0 14px}
.ad{display:grid;place-items:center;font:600 13px system-ui;letter-spacing:.06em;color:#7a5b00;background:repeating-linear-gradient(45deg,#ffe58a,#ffe58a 12px,#ffd84d 12px,#ffd84d 24px);margin:18px 0}
.btn{font:600 15px system-ui;padding:10px 18px;border-radius:8px;border:0;background:#1d1d1f;color:#fff}`
const story = `<p>The city council approved the new bike lanes on Tuesday after a two-hour debate, clearing the way for construction to begin in the spring.</p>
<p>Supporters said the lanes would make the busy corridor safer for the thousands of people who already ride it each day.</p>`
const PAGES = {
  '/hijack': `<!doctype html><title>Daily News</title><style>${css}</style><header>Daily News</header><main>
    <h1>Council approves downtown bike lanes</h1>${story}<button class="btn" id="read">Continue reading</button>${story}</main>
    <script>document.addEventListener('click', () => open('http://win-a-prize-now.test:${PORT}/claim'))</script>`,
  '/article': `<!doctype html><title>Daily News</title><style>${css}</style><header>Daily News</header>
    <div class="ad ad_unit" style="height:90px;max-width:728px;margin:16px auto">ADVERTISEMENT</div><main>
    <h1>Council approves downtown bike lanes</h1>${story}
    <div class="ad ad_unit" style="height:250px">ADVERTISEMENT</div>${story}</main>
    <script src="http://pagead2.googlesyndication.com:${PORT}/pagead/js/adsbygoogle.js"></script>`,
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/html' })
  res.end(PAGES[req.url] ?? '')
})
await new Promise(r => server.listen(PORT, r))
const url = p => `http://dailynews.test:${PORT}${p}`

// ---------- raw captures ----------
const shots = {}
const hush = await launch('hush', { mapHosts: true })
{
  const page = await hush.newPage()
  await page.setViewport({ width: 1100, height: 600, deviceScaleFactor: 2 })
  await page.goto(url('/hijack'))
  await sleep(600)
  await page.click('#read')
  await sleep(900)
  shots.hijack = await page.screenshot({ encoding: 'base64' })
  await page.setViewport({ width: 640, height: 760, deviceScaleFactor: 2 })
  await page.goto(url('/article'))
  await sleep(1200)
  shots.after = await page.screenshot({ encoding: 'base64' })
  // Toolbar popup, pointed at the article tab.
  const sw = await hush.targets().find(t => t.type() === 'service_worker').worker()
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://dailynews.test/*' }))[0].id)
  const id = new URL(hush.targets().find(t => t.type() === 'service_worker').url()).host
  const pop = await hush.newPage()
  await pop.evaluateOnNewDocument(id => { chrome.tabs.query = async () => [await chrome.tabs.get(id)] }, tabId)
  await pop.setViewport({ width: 260, height: 210, deviceScaleFactor: 3 })
  await pop.goto(`chrome-extension://${id}/popup.html`)
  await sleep(500)
  const h = await pop.$eval('body', b => b.getBoundingClientRect().height)
  shots.popup = await pop.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 260, height: h } })
}
await hush.close()
const plain = await launch('none', { mapHosts: true })
{
  const page = await plain.newPage()
  await page.setViewport({ width: 640, height: 760, deviceScaleFactor: 2 })
  await page.goto(url('/article'))
  await sleep(800)
  shots.before = await page.screenshot({ encoding: 'base64' })
}
await plain.close()
server.close()

// ---------- compose ----------
const browser = await launch('none')
const compose = async (file, w, h, html) => {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h })
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box}body{margin:0;width:${w}px;height:${h}px;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f}
    h2{font-size:40px;font-weight:700;letter-spacing:-.02em;margin:0}p.sub{font-size:20px;color:#6e6e73;margin:10px 0 0}
    .shot{border-radius:14px;box-shadow:0 10px 40px #0002;display:block}</style>${html}`)
  await sleep(200)
  await page.screenshot({ path: file })
  await page.close()
}
const img = (b64, style) => `<img class="shot" src="data:image/png;base64,${b64}" style="${style}">`

await compose(path.join(OUT, '1-redirects.png'), 1280, 800, `<div style="padding:54px 70px 0">
  <h2>Clicks go where you meant.</h2><p class="sub">Click-anywhere pop-ups and redirects are stopped. Real buttons work the first time.</p></div>
  <div style="padding:30px 0 0;display:flex;justify-content:center">${img(shots.hijack, 'width:1040px')}</div>`)
await compose(path.join(OUT, '2-ads.png'), 1280, 800, `<div style="padding:54px 70px 0">
  <h2>Ads and trackers, gone.</h2><p class="sub">Without Hush · with Hush. Lists update themselves every 12 hours.</p></div>
  <div style="display:flex;justify-content:center;gap:36px;padding:30px 0 0">${img(shots.before, 'width:500px')}${img(shots.after, 'width:500px')}</div>`)
await compose(path.join(OUT, '3-popup.png'), 1280, 800, `<div style="display:flex;align-items:center;gap:80px;height:800px;padding:0 110px">
  <div style="flex:1"><h2>Your call, per site.</h2><p class="sub">Turn off ad or redirect blocking for any site from the toolbar.
  Nothing is collected; everything runs in your browser.</p></div>${img(shots.popup, 'width:420px')}</div>`)
const icon = (await fs.readFile(path.join(DIR, '../extension/icons/128.png'))).toString('base64')
await compose(path.join(DIR, 'promo-440x280.png'), 440, 280, `<div style="height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#1d1d1f;color:#f5f5f7">
  <img src="data:image/png;base64,${icon}" width="72" height="72"><div style="font-size:26px;font-weight:700">Hush</div>
  <div style="font-size:15px;color:#a1a1a6">Ads, trackers and click hijacking, blocked</div></div>`)
await compose(path.join(DIR, 'hero-1280x640.png'), 1280, 640, `<div style="height:640px;display:flex;align-items:center;gap:56px;padding:0 90px;background:#1d1d1f;color:#f5f5f7">
  <div style="flex:1"><img src="data:image/png;base64,${icon}" width="84" height="84">
  <div style="font-size:64px;font-weight:700;letter-spacing:-.03em;margin-top:18px">Hush</div>
  <div style="font-size:26px;color:#a1a1a6;margin-top:10px;line-height:1.35">Blocks ads, trackers and the pop-ups<br>and redirects that hijack your clicks.</div></div>
  ${img(shots.hijack, 'width:560px')}</div>`)
await browser.close()
console.log('wrote', (await fs.readdir(OUT)).join(', '), '+ promo-440x280.png')
