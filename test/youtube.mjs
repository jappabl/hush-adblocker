// YouTube ad check against the real site. Each trial is a fresh Chrome profile (ads are
// served probabilistically and frequency-capped per profile), with and without the extension.
// Usage: node test/youtube.mjs [trials=3] [videoId,...]
import puppeteer from 'puppeteer'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')
const OUT = path.join(ROOT, 'test', 'out')
const TRIALS = Number(process.argv[2] ?? 3)
const VIDEOS = (process.argv[3] ?? 'JGwWNGJdvx8,kJQP7kiw5Fk').split(',')
const WATCH_S = 15
const sleep = ms => new Promise(r => setTimeout(r, ms))
await fs.mkdir(OUT, { recursive: true })

const adCount = r => (r ? (r.adPlacements?.length ?? 0) + (r.adSlots?.length ?? 0) + (r.playerAds ? 1 : 0) : -1)

async function trial(withExt, id, n) {
  const browser = await puppeteer.launch({
    pipe: true,
    args: [...(withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : []),
      '--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
    defaultViewport: { width: 1280, height: 800 },
  })
  try {
    if (withExt) await browser.waitForTarget(t => t.type() === 'service_worker')
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const initial = await page.evaluate(`(${adCount})(window.ytInitialPlayerResponse)`)
    let adSeconds = 0, wall = false
    for (let i = 0; i < WATCH_S; i++) {
      await sleep(1000)
      const s = await page.evaluate(() => ({
        ad: !!document.getElementById('movie_player')?.classList.contains('ad-showing'),
        wall: !!document.querySelector('ytd-enforcement-message-view-model'),
      }))
      if (s.ad) adSeconds++
      if (s.wall) wall = true
      if (i === 3) await page.screenshot({ path: path.join(OUT, `yt-${id}-${withExt ? 'on' : 'off'}-${n}.png`) })
    }
    const end = await page.evaluate(`(() => {
      const mp = document.getElementById('movie_player'), v = mp?.querySelector('video')
      return { t: v ? Math.round(v.currentTime) : null, playing: v ? !v.paused : false, rate: v?.playbackRate,
               ad: !!mp?.classList.contains('ad-showing'), playerAds: (${adCount})(mp?.getPlayerResponse?.()) }
    })()`)
    // In-app navigation: the next video's data arrives via fetch, not the inline script.
    // nextStart: seconds until the next video's own content is playing (not an ad).
    let nextAds = null, nextAdSeconds = 0, nextStart = null
    const next = await page.$('ytd-watch-next-secondary-results-renderer a[href^="/watch"]')
    if (next) {
      const before = page.url()
      await next.click()
      let prev = null
      for (let i = 1; i <= WATCH_S; i++) {
        await sleep(1000)
        const s = await page.evaluate(() => ({
          ad: !!document.getElementById('movie_player')?.classList.contains('ad-showing'),
          t: document.querySelector('#movie_player video')?.currentTime ?? 0,
        }))
        if (s.ad) nextAdSeconds++
        if (nextStart === null && !s.ad && prev && !prev.ad && s.t > prev.t && s.t < i + 1) nextStart = i - 1
        prev = s
        if (i === 4) await page.screenshot({ path: path.join(OUT, `yt-${id}-${withExt ? 'on' : 'off'}-${n}-next.png`) })
      }
      if (page.url() === before) nextStart = 'no-nav'
      nextAds = await page.evaluate(`(${adCount})(document.getElementById('movie_player')?.getPlayerResponse?.())`)
    }
    return { initial, adSeconds, wall, ...end, nextAds, nextAdSeconds, nextStart, errors: errors.length }
  } finally {
    await browser.close()
  }
}

const rows = []
for (const withExt of (process.env.SIDES ?? 'off,on').split(',').map(s => s === 'on')) {
  for (let n = 1; n <= TRIALS; n++) {
    for (const id of VIDEOS) {
      const r = await trial(withExt, id, n).catch(e => ({ error: e.message.slice(0, 80) }))
      rows.push({ ext: withExt ? 'on' : 'off', video: id, ...r })
      console.log(JSON.stringify(rows.at(-1)))
    }
  }
}
console.table(rows)
for (const side of ['off', 'on']) {
  const rs = rows.filter(r => r.ext === side && !r.error)
  console.log(`${side}: ad seen in ${rs.filter(r => r.adSeconds + r.nextAdSeconds > 0).length}/${rs.length} sessions, ` +
    `${rs.reduce((s, r) => s + r.adSeconds + r.nextAdSeconds, 0)} ad-seconds total, ad data on load in ${rs.filter(r => r.initial > 0).length}/${rs.length}, ` +
    `anti-adblock wall ${rs.filter(r => r.wall).length}, video playing at end ${rs.filter(r => r.playing && !r.ad).length}/${rs.length}, ` +
    `next video content started after (s): ${rs.map(r => r.nextStart ?? 'never').join(' ')}`)
}
