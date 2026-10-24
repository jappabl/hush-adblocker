// Launches Chrome with one blocker in its strongest configuration, for head-to-head benchmarks.
//   none    - plain Chrome
//   hush    - this extension
//   ubol    - uBlock Origin Lite, "Complete" filtering mode, popup blocking on, user scripts allowed
//   adguard - AdGuard (MV3), default protection, user scripts allowed
//   brave   - Brave with Shields (warmed profile so its filter lists are downloaded)
//   abp     - Adblock Plus (MV3, from the Chrome Web Store), default settings incl. Acceptable Ads
// Same-lists variants, to compare engines rather than list sizes:
//   hush-samelists - Hush with only the six lists uBO Lite enables by default
//   ubol-max       - uBO Lite, Complete mode, plus every extra privacy/tracking list it ships
// Competitors are fetched into .bench/ by `node test/bench/browsers.mjs fetch`.
import puppeteer from 'puppeteer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BENCH = path.join(ROOT, '.bench')
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
export const CONFIGS = ['none', 'hush', 'ubol', 'adguard', 'brave', 'abp']
const BASE = { 'hush-samelists': 'hush', 'ubol-max': 'ubol' }
const EXT = { hush: path.join(ROOT, 'extension'), ubol: path.join(BENCH, 'ubol'), adguard: path.join(BENCH, 'adguard'), abp: path.join(BENCH, 'abp') }
const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function fetchCompetitors() {
  await fs.mkdir(BENCH, { recursive: true })
  const get = (repo, pattern, dir) => {
    execFileSync('gh', ['release', 'download', '--repo', repo, '-p', pattern, '--clobber', '-O', path.join(BENCH, `${dir}.zip`)], { stdio: 'inherit' })
    execFileSync('rm', ['-rf', path.join(BENCH, dir)])
    execFileSync('unzip', ['-q', path.join(BENCH, `${dir}.zip`), '-d', path.join(BENCH, dir)])
  }
  get('uBlockOrigin/uBOL-home', '*chromium.zip', 'ubol')
  get('AdguardTeam/AdguardBrowserExtension', 'chrome-mv3.zip', 'adguard')
  // Adblock Plus only ships through the Chrome Web Store; fetch its official package from there.
  const crx = path.join(BENCH, 'abp.crx')
  execFileSync('curl', ['-sSL', '-o', crx, 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=154.0&acceptformat=crx2,crx3&x=id%3Dcfhdojbkjhnklbpkdaibdccddilifddb%26uc'])
  execFileSync('rm', ['-rf', path.join(BENCH, 'abp')])
  try { execFileSync('unzip', ['-q', crx, '-d', path.join(BENCH, 'abp')]) } catch {} // warns about the CRX header
  execFileSync('rm', ['-rf', path.join(BENCH, 'abp', '_metadata')]) // reserved name; Chrome refuses it unpacked
}

// Chrome's per-extension "Allow user scripts" switch; both competitors use it for scriptlets.
async function allowUserScripts(browser) {
  const page = await browser.newPage()
  await page.goto('chrome://extensions/')
  const ids = await page.evaluate(async () => (await chrome.management.getAll()).map(e => e.id))
  for (const id of ids) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(`chrome://extensions/?id=${id}`)
        await sleep(600)
        const toggle = await page.$('pierce/#allow-user-scripts')
        if (toggle && !(await toggle.evaluate(el => el.checked))) await toggle.click()
        if (!toggle || await toggle.evaluate(el => el.checked)) break
      } catch (e) {
        console.warn(`user-scripts toggle attempt ${attempt + 1} failed: ${e.message.slice(0, 80)}`)
      }
    }
  }
  await page.close()
}

const braveProfile = path.join(BENCH, 'brave-profile')
async function warmBrave() {
  if (await fs.access(path.join(braveProfile, '.warm')).then(() => true, () => false)) return
  const b = await puppeteer.launch({ executablePath: BRAVE, userDataDir: braveProfile, headless: true, pipe: true })
  await sleep(90000) // component updater downloads the Shields filter lists
  await b.close()
  await fs.writeFile(path.join(braveProfile, '.warm'), '')
}

export async function launch(variant, { mapHosts = false } = {}) {
  const name = BASE[variant] ?? variant
  // Look like a normal browser: ad networks don't serve headless/automated browsers.
  const args = ['--window-size=1280,900', '--autoplay-policy=no-user-gesture-required', '--lang=en-US',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36']
  if (mapHosts) args.push('--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable')
  const opts = { pipe: true, protocolTimeout: 60000, headless: !process.env.HEADFUL, defaultViewport: { width: 1280, height: 900 }, args }
  if (EXT[name]) args.push(`--disable-extensions-except=${EXT[name]}`, `--load-extension=${EXT[name]}`)
  if (name === 'brave') { await warmBrave(); opts.executablePath = BRAVE; opts.userDataDir = braveProfile }
  const browser = await puppeteer.launch(opts)

  if (EXT[name]) {
    const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 })
    // AdGuard is busy right after install (filters, onboarding tab); its settings page hangs until then.
    if (name === 'adguard') await sleep(8000)
    if (name === 'ubol' || name === 'adguard') await allowUserScripts(browser)
    if (name === 'ubol') {
      const id = new URL(sw.url()).host
      const page = await browser.newPage()
      await page.goto(`chrome-extension://${id}/dashboard.html`)
      for (let i = 0; i < 20; i++) {
        const level = await page.evaluate(() => chrome.runtime.sendMessage({ what: 'setDefaultFilteringMode', level: 3 })).catch(() => null)
        if (level === 3) break
        await sleep(500)
      }
      if (variant === 'ubol-max') {
        await page.evaluate(() => chrome.runtime.sendMessage({ what: 'applyRulesets', enabledRulesets: [
          'ublock-filters', 'easylist', 'easyprivacy', 'pgl', 'ublock-badware', 'urlhaus-full',
          'adguard-spyware-url', 'adguard-mobile', 'ublock-experimental'] }))
      }
      await page.close()
    }
    if (variant === 'hush-samelists') {
      const w = await sw.worker()
      await w.evaluate(async () => {
        // Wait for first-run setup (it re-enables every list, then schedules the update alarm).
        for (let i = 0; i < 100 && !(await chrome.alarms.get('update-lists')); i++) await new Promise(r => setTimeout(r, 100))
        await chrome.alarms.clearAll() // no auto-update bringing the other lists back
        await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['hagezi', 'hush'] })
      })
    }
    await sleep(name === 'adguard' || name === 'abp' ? 8000 : 2000) // let filters finish loading
    for (const p of await browser.pages()) if (!p.url().startsWith('about:blank')) await p.close().catch(() => {}) // onboarding tabs
  }
  return browser
}

if (process.argv[2] === 'fetch') await fetchCompetitors()
