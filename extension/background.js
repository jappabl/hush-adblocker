importScripts('site.js', 'compiler.js')

// Per-site switches, stored as registrable domains:
//   pausedAds   - no network blocking or element hiding on that site
//   pausedGuard - redirect guard not injected on that site
const PAUSE_RULE_ID = 1
const sitePattern = d => `*://*.${d}/*`
const YOUTUBE = ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com'].map(sitePattern)

async function settings() {
  const { pausedAds = [], pausedGuard = [] } = await chrome.storage.local.get(['pausedAds', 'pausedGuard'])
  return { pausedAds, pausedGuard }
}

const loadJson = path => fetch(chrome.runtime.getURL(path)).then(r => r.json())

// ---------- setup: content scripts + per-site pause rule ----------

async function apply() {
  const { pausedAds, pausedGuard } = await settings()
  const cos = await cosmetic()

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [PAUSE_RULE_ID],
    addRules: pausedAds.length ? [{
      id: PAUSE_RULE_ID, priority: 100, action: { type: 'allowAllRequests' },
      condition: { requestDomains: pausedAds, resourceTypes: ['main_frame'] },
    }] : [],
  })

  const common = { matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: true, matchOriginAsFallback: true }
  const exclude = domains => (domains.length ? { excludeMatches: domains.map(sitePattern) } : {})
  await chrome.scripting.unregisterContentScripts()
  await chrome.scripting.registerContentScripts([
    { id: 'guard', js: ['guard.js'], world: 'MAIN', ...common, ...exclude(pausedGuard) },
    { id: 'content', js: ['content.js'], ...common },
    { id: 'hide', css: ['data/cosmetic-generic.css'], ...common, ...exclude([...pausedAds, ...cos.noGeneric]) },
    { id: 'youtube', js: ['youtube.js'], world: 'MAIN', ...common, matches: YOUTUBE, ...exclude(pausedAds) },
  ])
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
  chrome.action.setBadgeBackgroundColor({ color: '#5f6368' })
  // A new version ships fresher packaged lists; start from those, then fetch.
  await useBundledLists()
  await apply()
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: UPDATE_EVERY_H * 60 })
  chrome.alarms.create(TALLY_ALARM, { periodInMinutes: 2 })
  // countVersion 2 (1.7.3): repeat pings capped per page. Totals counted the old way start over.
  const { lifetimeSince, countVersion } = await chrome.storage.local.get(['lifetimeSince', 'countVersion'])
  if (!lifetimeSince || countVersion !== 2) {
    await chrome.storage.local.set({ lifetimeSince: Date.now(), tallyFrom: Date.now(), lifetimeAds: 0, lifetimeRedirects: 0, countVersion: 2 })
  }
})

chrome.runtime.onStartup.addListener(async () => {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: UPDATE_EVERY_H * 60 })
  }
  if (!(await chrome.alarms.get(TALLY_ALARM))) chrome.alarms.create(TALLY_ALARM, { periodInMinutes: 2 })
})

// ---------- lifetime totals ----------
// Chrome keeps a record of each blocked request for a few minutes (across navigations and closed
// tabs) and allows 20 lookups per 10 minutes; adding up new records every 2 minutes stays well
// inside both. Redirects and popups are counted as they're blocked.
const TALLY_ALARM = 'tally'
let tallyChain = Promise.resolve()
const bump = updates => (tallyChain = tallyChain.then(async () => {
  const keys = Object.keys(updates)
  const cur = await chrome.storage.local.get(keys)
  await chrome.storage.local.set(Object.fromEntries(keys.map(k => [k, (cur[k] ?? 0) + updates[k]])))
}).catch(() => {}))

const notPauseRule = i => !(i.rule.ruleId === PAUSE_RULE_ID && i.rule.rulesetId === chrome.declarativeNetRequest.DYNAMIC_RULESET_ID)

// Pages keep pinging blocked trackers (YouTube's player: ~2 a second while playing), which would
// make the totals mostly a measure of how long a tab stayed open. Each rule counts at most
// PER_PAGE_CAP times per page. `seen` (session storage) holds the counts: tabId -> { navAt, rules }.
const PER_PAGE_CAP = 25
function countCapped(records, seen, navAtOf) {
  let n = 0
  for (const i of records) {
    const navAt = navAtOf(i.tabId)
    const page = i.timeStamp >= navAt ? navAt : -1 // -1: an earlier page in this tab
    let s = seen[i.tabId]
    if (!s || s.navAt !== page) s = seen[i.tabId] = { navAt: page, rules: {} }
    const key = `${i.rule.rulesetId}#${i.rule.ruleId}`
    if ((s.rules[key] = (s.rules[key] ?? 0) + 1) <= PER_PAGE_CAP) n++
  }
  return n
}

// Adds requests blocked since the last tally to the lifetime total. `fetched`: a getMatchedRules
// result the caller already has that covers that period (the popup's), saving a lookup.
// Runs one at a time, in turn with bump(), so nothing is counted twice.
const tally = (fetched, since = Infinity) => (tallyChain = tallyChain.then(async () => {
  const now = Date.now()
  const { tallyFrom = now, lifetimeAds = 0 } = await chrome.storage.local.get(['tallyFrom', 'lifetimeAds'])
  const m = fetched && since <= tallyFrom ? fetched
    : await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: tallyFrom }).catch(() => null)
  if (!m) return // over the lookup quota: the next run picks these up
  const fresh = m.rulesMatchedInfo.filter(i => i.timeStamp >= tallyFrom && i.timeStamp < now && notPauseRule(i))
  const session = await chrome.storage.session.get(null)
  const seen = session.seen ?? {}
  const n = countCapped(fresh, seen, tabId => session[`nav${tabId}`] ?? 0)
  await chrome.storage.session.set({ seen })
  await chrome.storage.local.set({ tallyFrom: now, lifetimeAds: lifetimeAds + n })
}).catch(() => {}))

// ---------- filter list auto-update ----------
// Packaged rulesets can't change after install, so fresh lists are compiled here and loaded
// as dynamic rules (Chrome allows 30k; the lists compile to ~22k), and the packaged ruleset
// each one replaces is switched off. Element hiding and popup rules go to storage.
// Generic hiding is a packaged stylesheet injected at document_start; selectors that are new
// since the build are added per frame instead (selectors removed upstream stay until rebuild).

const UPDATE_ALARM = 'update-lists'
const UPDATE_EVERY_H = 12
const LIST_RULE_ID_BASE = 1000 // dynamic rule ids below this are ours (PAUSE_RULE_ID)
const CSS_SUFFIX = '{display:none!important}'

const storedLists = async () => (await chrome.storage.local.get('lists')).lists ?? null

let updating = null
function updateLists(sources = HushCompiler.LISTS) {
  updating ??= doUpdate(sources).finally(() => { updating = null })
  return updating
}

async function doUpdate(sources) {
  const texts = await Promise.all(sources.map(async l => {
    const res = await fetch(l.url ?? chrome.runtime.getURL(l.local), { cache: 'no-store' })
    if (!res.ok) throw new Error(`${l.id}: HTTP ${res.status}`)
    return res.text()
  }))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texts.join('\0')))
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  if ((await storedLists())?.hash === hash) {
    await chrome.storage.local.set({ listsCheckedAt: Date.now() })
    return 'unchanged'
  }

  const out = HushCompiler.compile(sources, texts)
  const budget = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES - LIST_RULE_ID_BASE
  const dynamic = [], replaced = []
  for (const rs of out.rulesets) {
    // An error page served as a list compiles to almost nothing: keep everything as it is.
    const packaged = (await loadJson(`rules/${rs.id}.json`)).length
    if (rs.rules.length < packaged * 0.5) throw new Error(`${rs.id}: ${rs.rules.length} rules, expected ~${packaged}`)
    // Lists that don't fit the dynamic quota keep their packaged copy.
    if (dynamic.length + rs.rules.length > budget) continue
    for (const r of rs.rules) dynamic.push({ ...r, id: LIST_RULE_ID_BASE + dynamic.length })
    replaced.push(rs.id)
  }

  const bundledCss = await (await fetch(chrome.runtime.getURL('data/cosmetic-generic.css'))).text()
  const bundled = new Set(bundledCss.split('\n').filter(Boolean).map(l => l.slice(0, -CSS_SUFFIX.length)))
  const genericAdded = out.genericSelectors.filter(s => !bundled.has(s))

  // New rules go in before the packaged ones go out, so there is no unprotected moment.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: await listRuleIds(), addRules: dynamic })
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    disableRulesetIds: replaced,
    enableRulesetIds: HushCompiler.LISTS.map(l => l.id).filter(id => !replaced.includes(id)),
  })
  await chrome.storage.local.set({
    lists: { hash, cosmetic: out.cosmetic, popup: out.popup, genericAdded },
    listsCheckedAt: Date.now(),
  })
  cosmeticData = popupRules = null
  await apply()
  return 'updated'
}

const listRuleIds = async () => (await chrome.declarativeNetRequest.getDynamicRules()).map(r => r.id).filter(id => id >= LIST_RULE_ID_BASE)

async function useBundledLists() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: await listRuleIds() })
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: HushCompiler.LISTS.map(l => l.id) })
  await chrome.storage.local.remove(['lists', 'listsCheckedAt'])
  cosmeticData = popupRules = null
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TALLY_ALARM) return void tally()
  if (alarm.name !== UPDATE_ALARM && alarm.name !== `${UPDATE_ALARM}-retry`) return
  updateLists().catch(err => {
    console.warn('filter list update failed:', err.message)
    chrome.alarms.create(`${UPDATE_ALARM}-retry`, { delayInMinutes: 60 })
  })
})

// ---------- element hiding ----------

let cosmeticData
async function cosmetic() {
  if (!cosmeticData) {
    const stored = await storedLists()
    const c = stored?.cosmetic ?? await loadJson('data/cosmetic.json')
    cosmeticData = {
      genericAdded: stored?.genericAdded ?? [],
      specific: c.specific,
      exceptions: c.exceptions,
      conditional: c.conditional,
      generichide: new Set(c.generichide),
      elemhide: new Set(c.elemhide),
      noGeneric: [...c.generichide, ...c.elemhide],
    }
  }
  return cosmeticData
}

async function cosmeticCss(host) {
  const c = await cosmetic()
  const chain = domainChain(host)
  if (chain.some(d => c.elemhide.has(d))) return ''
  const sels = new Set(), skip = new Set()
  for (const d of chain) {
    c.specific[d]?.forEach(s => sels.add(s))
    c.exceptions[d]?.forEach(s => skip.add(s))
  }
  if (!chain.some(d => c.generichide.has(d))) {
    for (const [sel, notOn] of c.conditional) if (!notOn.some(d => chain.includes(d))) sels.add(sel)
    c.genericAdded.forEach(s => sels.add(s))
  }
  skip.forEach(s => sels.delete(s))
  return [...sels].map(s => `${s}{display:none!important}`).join('\n')
}

// ---------- popup backstop: known popunder/ad destinations, whatever opened them ----------

let popupRules
function abpToRegExp(f) {
  let start = '', end = ''
  if (f.startsWith('||')) { start = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?'; f = f.slice(2) }
  else if (f.startsWith('|')) { start = '^'; f = f.slice(1) }
  if (f.endsWith('|')) { end = '$'; f = f.slice(0, -1) }
  const body = f.replace(/[.+?${}()[\]\\|]/g, '\\$&').replace(/\*/g, '.*').replace(/\^/g, '(?:[^\\w.%-]|$)')
  return new RegExp(start + body + end, 'i')
}

async function popupBlocked(url, openerUrl) {
  popupRules ??= ((await storedLists())?.popup ?? await loadJson('data/popup.json')).map(r => ({ ...r, re: abpToRegExp(r.f) }))
  const opener = hostOf(openerUrl), dest = hostOf(url)
  if (!dest) return false
  const thirdParty = siteOf(opener) !== siteOf(dest)
  const openerChain = opener ? domainChain(opener) : []
  let blocked = false
  for (const r of popupRules) {
    if (r.t !== undefined && r.t !== thirdParty) continue
    if (r.d && !r.d.some(d => openerChain.includes(d))) continue
    if (r.n && r.n.some(d => openerChain.includes(d))) continue
    if (!r.re.test(url)) continue
    if (r.x) return false
    blocked = true
  }
  return blocked
}

// New tabs/windows opened by a page, watched for a few seconds (popunders often hop through redirects).
const opened = new Map() // tabId -> { sourceTabId, openerUrl, until }

chrome.webNavigation.onCreatedNavigationTarget.addListener(async d => {
  const frame = await chrome.webNavigation.getFrame({ tabId: d.sourceTabId, frameId: d.sourceFrameId }).catch(() => null)
  opened.set(d.tabId, {
    sourceTabId: d.sourceTabId, sourceFrameId: d.sourceFrameId, openerUrl: frame?.url ?? '', until: Date.now() + 8000,
    blank: !/^https?:/.test(d.url), // opened empty; the opener's script decides later where it goes
  })
  checkPopup(d.tabId, d.url)
})

chrome.webNavigation.onBeforeNavigate.addListener(d => {
  if (d.frameId === 0) checkPopup(d.tabId, d.url)
})

chrome.webNavigation.onErrorOccurred.addListener(d => {
  // Popup landed on a page the network rules block (malware/ad page): close it rather than show an error.
  const o = opened.get(d.tabId)
  if (d.frameId === 0 && o && Date.now() < o.until && d.error === 'net::ERR_BLOCKED_BY_CLIENT') closePopup(d.tabId, o, d.url)
})

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.get('seen').then(({ seen }) => { if (seen?.[tabId]) { delete seen[tabId]; chrome.storage.session.set({ seen }) } })
  opened.delete(tabId)
  pageReports.delete(tabId)
  chrome.storage.session.remove(`n${tabId}`)
})

async function checkPopup(tabId, url) {
  const o = opened.get(tabId)
  if (!o || Date.now() > o.until || !/^https?:/.test(url)) return
  if ((await settings()).pausedGuard.includes(siteOf(hostOf(o.openerUrl)))) return
  if (await popupBlocked(url, o.openerUrl)) return closePopup(tabId, o, url)
  // A popup that opened blank and is now being sent somewhere (a popunder trick): ask the opener's
  // guard whether that destination fits what the user clicked. No answer means allow.
  if (o.blank) {
    o.blank = false
    const ok = await chrome.tabs.sendMessage(o.sourceTabId, { type: 'popupCheck', url }, { frameId: o.sourceFrameId }).catch(() => true)
    if (ok === false) closePopup(tabId, o, url)
  }
}

function closePopup(tabId, o, url) {
  opened.delete(tabId)
  chrome.tabs.remove(tabId).catch(() => {})
  blocked(o.sourceTabId, 'popup', url, true)
}

// Tab-under backstop: the page redirected itself (no click) to a known popunder destination.
chrome.webNavigation.onCommitted.addListener(async d => {
  if (d.frameId !== 0) return
  chrome.storage.session.remove(`n${d.tabId}`)
  chrome.storage.session.set({ [`nav${d.tabId}`]: d.timeStamp }) // "blocked on this page" counts from here
  if (opened.has(d.tabId) || !d.transitionQualifiers.includes('client_redirect')) return
  if (await popupBlocked(d.url, '')) {
    chrome.tabs.goBack(d.tabId).catch(() => {})
    blocked(d.tabId, 'redirect', d.url, false)
  }
})

// ---------- messages ----------

// A page can fire the guard's report event itself, so reports that come from a page are capped per
// tab (5 per 10 s). Blocks the background detects on its own aren't capped. Either way, the
// blocking itself never depends on the report.
const pageReports = new Map() // tabId -> timestamps
function pageReportAllowed(tabId) {
  const now = Date.now(), times = (pageReports.get(tabId) ?? []).filter(t => now - t < 10000)
  if (times.length >= 5) return false
  times.push(now)
  pageReports.set(tabId, times)
  return true
}

async function blocked(tabId, kind, url, canContinue) {
  bump({ lifetimeRedirects: 1 })
  const key = `n${tabId}`
  const n = ((await chrome.storage.session.get(key))[key] ?? 0) + 1
  await chrome.storage.session.set({ [key]: n })
  chrome.tabs.sendMessage(tabId, { type: 'toast', kind, url, canContinue }, { frameId: 0 }).catch(() => {})
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tab = sender.tab
  switch (msg.type) {
    case 'cosmetic': {
      if (!tab) return
      const top = sender.frameId === 0 ? sender.url : tab.url
      ;(async () => {
        const { pausedAds } = await settings()
        if (pausedAds.includes(siteOf(hostOf(top)))) return
        const host = hostOf(sender.url) || hostOf(sender.origin)
        const css = host && await cosmeticCss(host)
        if (css) await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds: [sender.frameId] }, css, origin: 'USER' })
      })().catch(() => {})
      return
    }
    case 'blocked':
      if (tab && pageReportAllowed(tab.id)) blocked(tab.id, msg.kind, msg.url, msg.kind === 'popup' || sender.frameId === 0)
      return
    case 'continue':
      if (!tab || !/^https?:/.test(msg.url)) return
      if (msg.kind === 'popup') chrome.tabs.create({ url: msg.url, openerTabId: tab.id, index: tab.index + 1 })
      else chrome.tabs.update(tab.id, { url: msg.url })
      return
    case 'state': // from popup.html
      (async () => {
        const site = siteOf(hostOf(msg.url))
        const { pausedAds, pausedGuard } = await settings()
        const key = `n${msg.tabId}`, navKey = `nav${msg.tabId}`
        // One lookup covers both this page and the lifetime total (Chrome allows 20 per 10 minutes).
        const { tallyFrom = Date.now() } = await chrome.storage.local.get('tallyFrom')
        const navAt = (await chrome.storage.session.get(navKey))[navKey] ?? 0
        const since = Math.min(tallyFrom, navAt)
        const m = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: since }).catch(() => null)
        await tally(m, since)
        reply({
          site,
          ads: !pausedAds.includes(site),
          guard: !pausedGuard.includes(site),
          adsBlocked: m ? countCapped(m.rulesMatchedInfo.filter(i => i.tabId === msg.tabId && i.timeStamp >= navAt && notPauseRule(i)), {}, () => navAt) : 0,
          listsCheckedAt: (await chrome.storage.local.get('listsCheckedAt')).listsCheckedAt ?? null,
          lifetime: await chrome.storage.local.get(['lifetimeAds', 'lifetimeRedirects']).then(l => (l.lifetimeAds ?? 0) + (l.lifetimeRedirects ?? 0)),
          redirectsBlocked: (await chrome.storage.session.get(key))[key] ?? 0,
        })
      })()
      return true
    case 'toggle': // from popup.html: { site, which: 'pausedAds'|'pausedGuard', on }
      (async () => {
        const s = await settings()
        const list = new Set(s[msg.which])
        msg.on ? list.delete(msg.site) : list.add(msg.site)
        await chrome.storage.local.set({ [msg.which]: [...list] })
        await apply()
        reply(true)
      })()
      return true
  }
})
