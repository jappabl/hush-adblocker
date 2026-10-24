// Filter list compiler: Adblock Plus / uBlock syntax -> declarativeNetRequest rules,
// element-hiding data and popup rules. Shared by the build script (Node) and the
// extension's background worker (auto-update), so it uses no Node or extension APIs.
// Loaded as a plain script; exposes globalThis.HushCompiler = { LISTS, compile }.
(() => {
// blockDocuments: rules without a type option also block whole pages (malware lists).
const LISTS = [
  { id: 'easylist', file: 'easylist.txt', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', file: 'easyprivacy.txt', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'ubo', file: 'ubo-filters.txt', url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt' },
  { id: 'pgl', file: 'pgl.txt', url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext' },
  // DNS-style domain list: phone/OS telemetry, ad SDKs and trackers the browser lists leave out.
  { id: 'hagezi', file: 'hagezi-pro.txt', url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/pro.txt' },
  // Hush's own additions, packaged with the extension (extension/filters/hush.txt).
  { id: 'hush', local: 'filters/hush.txt' },
  { id: 'badware', file: 'ubo-badware.txt', url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt', blockDocuments: true },
  // Domains-only edition: the full list adds ~34k single-file URLs (mostly malware payloads on GitHub),
  // one rule each, which would not fit Chrome's rule limits.
  { id: 'urlhaus', file: 'urlhaus-domains.txt', url: 'https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-domains-online.txt', blockDocuments: true },
]

const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other']

const TYPE_MAP = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  object: 'object', 'object-subrequest': 'object', xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
  subdocument: 'sub_frame', frame: 'sub_frame', ping: 'ping', beacon: 'ping', media: 'media',
  font: 'font', websocket: 'websocket', other: 'other',
}

// Element-hiding syntax that needs a script engine (procedural/extended selectors).
const PROCEDURAL = /:(-abp-|has-text|contains|xpath|upward|remove|style|matches-|min-text-length|watch-attr|others|if\(|if-not|nth-ancestor|remove-attr|remove-class|shadow)/

// IDN domains -> punycode; returns null for anything that isn't a plain hostname.
function normDomain(d) {
  d = d.trim().toLowerCase()
  if (!d || d.includes('*') || d.startsWith('/')) return null
  if (/^[a-z0-9.-]+$/.test(d)) return d
  try { return new URL('http://' + d).hostname } catch { return null }
}

function splitDomains(value, sep) {
  const yes = [], no = []
  let dropped = false
  for (const raw of value.split(sep)) {
    const neg = raw.startsWith('~')
    const d = normDomain(neg ? raw.slice(1) : raw)
    if (!d) { if (!neg) dropped = true; continue }
    ;(neg ? no : yes).push(d)
  }
  return { yes, no, dropped }
}

// ---------- network filters ----------

function parseNetwork(line) {
  let exception = false
  if (line.startsWith('@@')) { exception = true; line = line.slice(2) }

  let pattern = line, opts = []
  const dollar = line.lastIndexOf('$')
  if (dollar >= 0 && /^[\w~,=\-|.*:%/]+$/.test(line.slice(dollar + 1))) {
    pattern = line.slice(0, dollar)
    opts = line.slice(dollar + 1).split(',')
  }
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) return null // regex filters

  const f = {
    exception, pattern, types: new Set(), notTypes: new Set(), popup: false, document: false,
    thirdParty: undefined, domains: [], notDomains: [], important: false, matchCase: false,
    cosmeticOff: null, methods: null,
  }
  for (const opt of opts) {
    const neg = opt.startsWith('~')
    const body = neg ? opt.slice(1) : opt
    const eq = body.indexOf('=')
    const key = eq < 0 ? body : body.slice(0, eq)
    const val = eq < 0 ? '' : body.slice(eq + 1)

    if (key in TYPE_MAP) { (neg ? f.notTypes : f.types).add(TYPE_MAP[key]); continue }
    switch (key) {
      case 'popup': case 'popunder': if (!neg) f.popup = true; break
      case 'document': case 'doc': if (!neg) f.document = true; break
      case 'all': ALL_TYPES.forEach(t => t !== 'main_frame' && f.types.add(t)); f.document = true; break // main_frame block also covers popups
      case 'third-party': case '3p': f.thirdParty = !neg; break
      case 'first-party': case '1p': f.thirdParty = neg; break
      case 'domain': case 'from': {
        const { yes, no, dropped } = splitDomains(val, '|')
        if (dropped && !yes.length) return null
        f.domains.push(...yes); f.notDomains.push(...no)
        break
      }
      case 'match-case': f.matchCase = true; break
      case 'important': f.important = true; break
      case 'elemhide': case 'ehide': f.cosmeticOff = 'elemhide'; break
      case 'generichide': case 'ghide': f.cosmeticOff ??= 'generichide'; break
      case 'method': f.methods = val.split('|').filter(m => !m.startsWith('~')).map(m => m.toLowerCase()); break
      case 'redirect': case 'empty': case 'mp4': break // block, without the surrogate
      default:
        return null // csp, removeparam, redirect-rule, ...: not expressible in declarativeNetRequest
    }
  }
  return f
}

function toUrlFilter(p) {
  if (p === '' || p === '*' || p === '||' || p === '|') return { filter: undefined }
  if (p.startsWith('||*')) p = p.slice(3)
  p = p.replace(/^\*+/, '').replace(/\*+$/, '')
  if (!p) return { filter: undefined }
  if (/[^\x20-\x7e]/.test(p)) return null
  const inner = p.replace(/^\|\|?/, '').replace(/\|$/, '')
  if (inner.includes('|')) return null
  return { filter: p }
}

// Host-only patterns like ||ads.example.com^ get merged into one rule per option set.
const HOST_ONLY = /^\|\|([a-z0-9.-]+\.[a-z0-9-]+)\^?\|?$/

function toDnr(f, list) {
  const uf = toUrlFilter(f.pattern)
  if (!uf) return null
  const condition = {}
  if (uf.filter !== undefined) condition.urlFilter = uf.filter
  if (f.matchCase) condition.isUrlFilterCaseSensitive = true
  if (f.thirdParty !== undefined) condition.domainType = f.thirdParty ? 'thirdParty' : 'firstParty'
  if (f.domains.length) condition.initiatorDomains = f.domains
  if (f.notDomains.length) condition.excludedInitiatorDomains = f.notDomains
  if (f.methods?.length) condition.requestMethods = f.methods

  let action, priority
  if (f.exception && f.document) {
    action = { type: 'allowAllRequests' }; priority = 2
    condition.resourceTypes = ['main_frame', 'sub_frame']
  } else {
    action = { type: f.exception ? 'allow' : 'block' }
    priority = f.exception ? (f.important ? 4 : 2) : (f.important ? 3 : 1)
    const types = new Set(f.types)
    if (f.document) types.add('main_frame')
    if (types.size) condition.resourceTypes = [...types]
    else if (f.notTypes.size) {
      condition.excludedResourceTypes = [...f.notTypes]
      if (!list.blockDocuments && !f.notTypes.has('main_frame')) condition.excludedResourceTypes.push('main_frame')
    } else if (list.blockDocuments && !f.exception) condition.resourceTypes = ALL_TYPES
  }
  if (!condition.urlFilter && !condition.initiatorDomains && !condition.resourceTypes?.includes('main_frame') && action.type === 'block') {
    return null // a bare type/third-party filter would block far too much
  }
  return { action, priority, condition }
}

// ---------- cosmetic filters ----------

const COSMETIC = /^([^/|@"!#$]*?)(#@?#)(.+)$/

function validSelector(sel) {
  return !sel.startsWith('+js(') && !sel.startsWith('^') && !/[{}]/.test(sel) &&
    !PROCEDURAL.test(sel) && !sel.includes(':-abp-')
}

// ---------- popup filters (matched in the background worker) ----------

function toPopupRule(f) {
  const uf = toUrlFilter(f.pattern)
  if (!uf || uf.filter === undefined) return null
  const r = { f: uf.filter }
  if (f.exception) r.x = 1
  if (f.thirdParty !== undefined) r.t = f.thirdParty
  if (f.domains.length) r.d = f.domains
  if (f.notDomains.length) r.n = f.notDomains
  return r
}


// texts: one string per entry of `lists`, same order.
// Returns { rulesets: [{ id, rules, stats }], cosmetic, genericSelectors, popup }.
function compile(lists, texts) {
  const generic = new Map()       // selector -> Set(domains where it must not apply)
  const specific = new Map()      // domain -> Set(selector)
  const hideExceptions = new Map()// domain -> Set(selector)
  const globalExceptions = new Set()
  const generichide = new Set(), elemhide = new Set()
  const popup = []
  const add = (map, key, val) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(val)
  const rulesets = []

  for (const [i, list] of lists.entries()) {
    const lines = texts[i].split(/\r?\n/)
    const badfilters = new Set(lines.filter(l => /[$,]badfilter\b/.test(l)).map(l => l.replace(/[$,]badfilter\b/, '')))
    const rules = [], seen = new Set()
    const grouped = new Map() // key -> { rule, domains: Set }
    let skipped = 0

    for (let line of lines) {
      line = line.trim()
      if (!line || line.startsWith('!') || line.startsWith('[') || /^#(?![@?$%]?#)/.test(line) || badfilters.has(line) || line.includes('badfilter')) continue

      if (/#[@]?[?$%]#|#@\?#/.test(line)) { skipped++; continue } // procedural / scriptlet / css-injection
      const cm = line.match(COSMETIC)
      if (cm) {
        const [, domainPart, sep, sel] = cm
        if (!validSelector(sel)) { skipped++; continue }
        const { yes, no } = splitDomains(domainPart, ',')
        if (domainPart && !yes.length && !no.length) { skipped++; continue }
        if (sep === '#@#') {
          if (!domainPart) globalExceptions.add(sel)
          for (const d of yes) add(hideExceptions, d, sel)
        } else if (!yes.length) {
          const nots = generic.get(sel) ?? generic.set(sel, new Set()).get(sel)
          no.forEach(d => nots.add(d))
        } else {
          for (const d of yes) add(specific, d, sel)
          for (const d of no) add(hideExceptions, d, sel)
        }
        continue
      }

      // hosts-style bare domains / IPs (urlhaus)
      if (/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(line) || /^\d+\.\d+\.\d+\.\d+$/.test(line)) line = `||${line.toLowerCase()}^`

      const f = parseNetwork(line)
      if (!f) { skipped++; continue }

      if (f.cosmeticOff) {
        if (f.exception) {
          const host = f.pattern.match(HOST_ONLY)?.[1]
          for (const d of [host, ...f.domains].filter(Boolean)) (f.cosmeticOff === 'elemhide' ? elemhide : generichide).add(d)
        }
        if (!f.types.size && !f.document) continue
      }
      if (f.popup) {
        const pr = toPopupRule(f)
        if (pr) popup.push(pr)
        if (!f.types.size && !f.document) continue
      }

      const rule = toDnr(f, list)
      if (!rule) { skipped++; continue }

      const host = rule.condition.urlFilter?.match(HOST_ONLY)?.[1]
      if (host && !rule.condition.isUrlFilterCaseSensitive) {
        const { urlFilter, ...rest } = rule.condition
        const key = JSON.stringify({ a: rule.action, p: rule.priority, c: rest })
        const g = grouped.get(key) ?? grouped.set(key, { rule: { ...rule, condition: rest }, domains: new Set() }).get(key)
        g.domains.add(host)
        continue
      }
      const key = JSON.stringify(rule)
      if (seen.has(key)) continue
      seen.add(key)
      rules.push(rule)
    }

    for (const { rule, domains } of grouped.values()) {
      rules.push({ ...rule, condition: { requestDomains: [...domains].sort(), ...rule.condition } })
    }
    rules.forEach((r, i) => { r.id = i + 1 })
    const domainCount = [...grouped.values()].reduce((n, g) => n + g.domains.size, 0)
    rulesets.push({
      id: list.id,
      rules: rules.map(({ id, priority, action, condition }) => ({ id, priority, action, condition })),
      stats: { rules: rules.length, mergedDomains: domainCount, skipped },
    })
  }

  // Global #@# exceptions remove a selector everywhere; per-domain exceptions to a generic
  // selector move it out of the static stylesheet so it can be withheld on those domains.
  for (const sel of globalExceptions) generic.delete(sel)
  for (const [d, sels] of hideExceptions) for (const sel of sels) generic.get(sel)?.add(d)

  const staticGeneric = [...generic].filter(([, nots]) => !nots.size).map(([sel]) => sel)
  const conditional = [...generic].filter(([, nots]) => nots.size).map(([sel, nots]) => [sel, [...nots]])

  const toObj = map => Object.fromEntries([...map].map(([k, v]) => [k, [...v]]))
  return {
    rulesets,
    genericSelectors: staticGeneric,
    cosmetic: {
      specific: toObj(specific),
      exceptions: toObj(hideExceptions),
      conditional,
      generichide: [...generichide].filter(d => /^[a-z0-9.-]+$/.test(d)),
      elemhide: [...elemhide].filter(d => /^[a-z0-9.-]+$/.test(d)),
    },
    popup,
  }
}

// One rule per selector, so a selector Chrome can't parse only knocks out itself.
const toCss = selectors => selectors.map(s => `${s}{display:none!important}`).join('\n')

globalThis.HushCompiler = { LISTS, compile, toCss }
})()
