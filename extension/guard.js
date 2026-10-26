// Redirect guard. Runs in the page's own JS world at document_start, before any page script.
//
// A popup or cross-site navigation is allowed when it plausibly matches what the user did:
//   - same site as the current page (but not a copy of this very page: that's a tab-under), or
//   - the user clicked a real link and the destination is where that link pointed when pressed, or
//   - (navigation only) the user clicked a button/control, or
//   - (popup only) the user clicked a control and the destination is a known login/payment/share provider, or
//   - (navigation only) the page is a pure redirect page: no interaction yet and still loading.
// Anything else (click-anywhere popunders, timed scam redirects, links hijacked by page scripts)
// is cancelled and reported to content.js, which shows a notice with a way to continue.
//
// Blocking alone still wastes the click, so the guard also finishes what the user meant:
//   - invisible ad iframes/links covering the page are switched off when the pointer reaches them,
//   - a click swallowed by an empty overlay or by the hijacking script is handed to the real target,
//   - a link whose address was swapped or whose click was hijacked goes where it pointed.
(() => {
  'use strict'
  const W = window


  const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'sch'])
  const siteOf = host => {
    host = host.toLowerCase().replace(/\.$/, '')
    if (/^[\d.]+$/.test(host) || host.includes(':')) return host
    const p = host.split('.'), n = p.length
    if (n <= 2) return host
    return p.slice(SECOND_LEVEL.has(p[n - 2]) && p[n - 1].length === 2 ? -3 : -2).join('.')
  }
  // null for about:blank, javascript:, data: etc.
  const siteOfUrl = url => {
    try {
      const u = new URL(url, location.href)
      return u.protocol === 'http:' || u.protocol === 'https:' ? siteOf(u.hostname) : null
    } catch { return null }
  }
  const here = () => siteOf(location.hostname)
  // Forwarding links (/go?to=…, /out?url=…, google.com/url?q=…) are judged by where they end up.
  const FORWARDER = /^\/(url|amp\/s|redirect|redir|r|l|out|outgoing|go|goto|link|away|exit|click|leave|external|aclk)(\/|\.php|$)/i
  const unwrap = url => {
    try {
      const u = new URL(url, location.href)
      if (!FORWARDER.test(u.pathname) && !/^(l|out|r)\./.test(u.hostname)) return url
      for (const v of u.searchParams.values()) if (/^https?:\/\//i.test(v) && siteOfUrl(v) !== siteOf(u.hostname)) return v
    } catch {}
    return url
  }
  const docUrl = url => { try { const u = new URL(url, location.href); return u.origin + u.pathname + u.search } catch { return '' } }
  const isThisPage = url => docUrl(url) === docUrl(location.href)

  // Big first-party platforms where nobody else can run script on their pages. They don't hijack
  // clicks, and their sign-in/checkout machinery (page-wide click handlers, popups, redirects back)
  // is what the guard could interfere with, so on these the guard steps aside entirely.
  // Never put multi-tenant hosting here (anyone can publish pages on x.firebaseapp.com).
  const NO_HIJACK = new Set(['google.com', 'youtube.com', 'apple.com', 'icloud.com', 'microsoft.com',
    'microsoftonline.com', 'live.com', 'office.com', 'outlook.com', 'microsoft365.com', 'facebook.com',
    'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'github.com', 'amazon.com', 'paypal.com',
    'stripe.com', 'klarna.com', 'affirm.com', 'afterpay.com', 'discord.com', 'yahoo.com'])

  // Sign-in, payment and share providers as destinations: popups to them are allowed from any
  // button click. Some give every customer a subdomain; those only count on their sign-in paths.
  const TENANT_PATHS = { 'firebaseapp.com': /^\/__\/auth\//, 'web.app': /^\/__\/auth\// }
  const trustedDest = url => {
    try {
      const u = new URL(url, location.href), site = siteOf(u.hostname)
      return TRUSTED.has(site) && (!TENANT_PATHS[site] || TENANT_PATHS[site].test(u.pathname))
    } catch { return false }
  }
  const TRUSTED = new Set([
    // sign-in
    'google.com', 'youtube.com', 'apple.com', 'icloud.com', 'microsoft.com', 'microsoftonline.com', 'live.com',
    'office.com', 'outlook.com', 'microsoft365.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'linkedin.com', 'github.com', 'gitlab.com', 'amazon.com', 'discord.com', 'yahoo.com', 'line.me', 'vk.com',
    'okta.com', 'auth0.com', 'onelogin.com', 'duosecurity.com', 'pingidentity.com', 'amazoncognito.com',
    'firebaseapp.com', 'web.app', 'login.gov', 'id.me', 'accounts.dev', 'workos.com', 'stytch.com',
    // payments
    'paypal.com', 'stripe.com', 'klarna.com', 'affirm.com', 'afterpay.com', 'clearpay.co.uk', 'zip.co', 'sezzle.com',
    'venmo.com', 'cash.app', 'shop.app', 'shopify.com', 'squareup.com', 'adyen.com', 'braintreegateway.com',
    'checkout.com', 'authorize.net', 'wise.com', 'revolut.com', 'coinbase.com',
    // share, chat, calendar, files
    'pinterest.com', 'reddit.com', 'whatsapp.com', 'telegram.org', 't.me', 'tumblr.com', 'zoom.us',
    'dropbox.com', 'zendesk.com', 'intercom.com', 'calendly.com'])
  // The address this page was loaded with, read before any page script can touch it. Sign-in and
  // checkout pages announce where they'll send you back to (redirect_uri=, continue=, return_to=…);
  // going there is the flow completing, not a hijack.
  const startUrl = (() => { let u = location.href; for (let i = 0; i < 3; i++) try { u = decodeURIComponent(u) } catch { break } return u })()
  const announced = url => {
    try { const u = new URL(url, location.href); return u.hostname !== location.hostname && startUrl.includes('//' + u.host) } catch { return false }
  }
  const CONTROL = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch]'
  const MEDIA = 'img,video,canvas,svg,iframe,button,input,select,textarea'

  const nativeOpen = W.open
  const nativeDispatch = EventTarget.prototype.dispatchEvent
  const nativeSetTimeout = W.setTimeout.bind(W)
  // Talks to content.js with the browser's own originals, so a page that replaces dispatchEvent or
  // CustomEvent later can't intercept or rewrite what the guard says.
  const NativeCustomEvent = W.CustomEvent
  const tell = (type, detail) => nativeDispatch.call(W, new NativeCustomEvent(type, { detail }))

  // On those platforms (and in their frames embedded elsewhere, like Google's sign-in prompt) the
  // guard steps aside. It only answers the background's blank-popup check: allowed if the user
  // clicked or pressed a key in the last 5 s (an unanswered check counts as deny).
  if (NO_HIJACK.has(here())) {
    let pressedAt = -Infinity
    const add = EventTarget.prototype.addEventListener
    for (const type of ['pointerdown', 'keydown', 'touchstart']) add.call(W, type, e => { if (e.isTrusted) pressedAt = performance.now() }, true)
    add.call(W, '__hush_ask', e => {
      const s = String(e.detail)
      tell('__hush_answer', s.slice(0, s.indexOf(' ')) + ' ' + (performance.now() - pressedAt < 5000 ? 1 : 0))
    }, true)
    return
  }

  // Wrapped functions report the original's source code, so pages checking for "native code"
  // (anti-adblock scripts, YouTube) see nothing unusual.
  const originals = new WeakMap()
  const nativeToString = Function.prototype.toString
  const toString = function toString() { return nativeToString.call(originals.get(this) ?? this) }
  originals.set(toString, nativeToString)
  Function.prototype.toString = toString
  const disguise = (fake, real) => { originals.set(fake, real); return fake }
  const anchorOf = el => el?.closest?.('a[href],area[href]') ?? null
  const opensNewWindow = el => {
    const t = (el.target || document.querySelector('base[target]')?.target || '').toLowerCase()
    return t !== '' && t !== '_self' && t !== '_top' && t !== '_parent'
  }

  // ---- what did the user last touch ----
  // href: where the link under the pointer pointed when the press began. Hijackers swap
  // a link's address on mousedown, after this listener (the first one registered) has run.
  let last = null, interacted = false
  const note = e => {
    if (!e.isTrusted) return
    let el = e.composedPath()[0]
    if (!(el instanceof Element)) el = el?.parentElement ?? null
    interacted = true
    const anchor = anchorOf(el)
    const pressStart = e.type === 'pointerdown' || e.type === 'touchstart' || e.type === 'keydown'
    const href = anchor && (pressStart || last?.anchor !== anchor) ? anchor.href : (last?.href ?? null)
    last = { t: performance.now(), el, anchor, href, x: e.clientX, y: e.clientY }
  }
  for (const type of ['pointerdown', 'mousedown', 'click', 'auxclick', 'touchstart', 'keydown']) {
    W.addEventListener(type, note, true)
  }
  const recent = ms => (last && last.el && performance.now() - last.t < ms ? last.el : null)

  // ---- catch-all click listeners ----
  // "Click anywhere" hijacks hang one listener on window/document/body. A button's own handler
  // may send the user to another site (checkout, sign-in); a catch-all listener that does so
  // is a hijack, unless the clicked control names that destination itself (data-href etc.).
  // catchAll > 0 while such a listener, or a timer it set, is running.
  let catchAll = 0
  const PRESS = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'auxclick'])
  // Page-wide listeners on these never express "take me to another site": presses plus
  // movement, scrolling, keys, focus and history events (exit-intent, back-button and scroll hijacks).
  const CATCH_ALL = new Set([...PRESS, 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress', 'mousemove', 'mouseover',
    'mouseout', 'mouseenter', 'mouseleave', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
    'touchmove', 'wheel', 'scroll', 'popstate', 'hashchange', 'blur', 'focus', 'focusin', 'focusout', 'visibilitychange',
    'pagehide', 'resize', 'selectionchange'])
  // Duck-typed so a window/document from another same-origin frame counts too.
  const isPageWide = t => !!t && (t === t.window || t.nodeType === 9 || (t.nodeType === 1 && (t.localName === 'html' || t.localName === 'body')))
  const realmOf = t => (t === t.window ? t : t.nodeType === 9 ? t.defaultView : t.ownerDocument?.defaultView)
  let asyncCatchAllAt = -Infinity // an async catch-all listener ran: what it does after `await` can't be traced
  const asCatchAll = fn => function () {
    catchAll++
    try {
      const out = typeof fn === 'function' ? fn.apply(this, arguments) : fn.handleEvent(...arguments)
      if (out && typeof out.then === 'function') asyncCatchAllAt = performance.now()
      return out
    } finally { catchAll-- }
  }
  // Listeners on specific elements (or app containers, e.g. a React root): a press there has an owner.
  const ownPress = new WeakSet()
  const wrapped = new WeakMap()
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener
  // `this ?? W`: a bare addEventListener(...) call from page script means window.
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const target = this ?? W
    if (fn && CATCH_ALL.has(type) && isPageWide(target)) {
      // Registered with another frame's addEventListener: let that frame's guard track it.
      const realm = realmOf(target)
      if (realm && realm !== W) {
        try { return realm.EventTarget.prototype.addEventListener.call(target, type, fn, opts) } catch {}
      }
      if (!wrapped.has(fn)) wrapped.set(fn, asCatchAll(fn))
      fn = wrapped.get(fn)
    } else if (fn && PRESS.has(type) && target instanceof Element) ownPress.add(target)
    return nativeAdd.call(target, type, fn, opts)
  }
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    return nativeRemove.call(this ?? W, type, (fn && wrapped.get(fn)) || fn, opts)
  }
  disguise(EventTarget.prototype.addEventListener, nativeAdd)
  disguise(EventTarget.prototype.removeEventListener, nativeRemove)
  // document.onclick = ..., window.onmousedown = ..., body.onclick = ...
  for (const type of CATCH_ALL) {
    for (const holder of [Document.prototype, HTMLElement.prototype, W]) { // window's own, not on Window.prototype
      const d = Object.getOwnPropertyDescriptor(holder, 'on' + type)
      if (!d?.set) continue
      Object.defineProperty(holder, 'on' + type, {
        ...d,
        set(fn) { d.set.call(this, typeof fn === 'function' && isPageWide(this) ? asCatchAll(fn) : fn) },
      })
    }
  }
  // Work scheduled from a catch-all listener (timers, promise callbacks, frames) still counts as it.
  const carry = (obj, key, argIndexes) => {
    const orig = obj[key]
    obj[key] = disguise(function () {
      if (catchAll) for (const i of argIndexes) if (typeof arguments[i] === 'function') arguments[i] = asCatchAll(arguments[i])
      return orig.apply(this, arguments)
    }, orig)
  }
  carry(W, 'setTimeout', [0])
  carry(W, 'requestAnimationFrame', [0])
  carry(W, 'queueMicrotask', [0])
  carry(Promise.prototype, 'then', [0, 1])
  const hasOwner = el => {
    for (let n = el; n instanceof Element && !isPageWide(n); n = n.parentElement ?? n.getRootNode()?.host) {
      if (ownPress.has(n) || n.hasAttribute('onclick') || typeof n.onclick === 'function') return true
    }
    return false
  }
  // Does the control (or its close ancestors) carry the destination, e.g. data-href="https://pay..."?
  const namesDestination = (el, url) => {
    const dest = siteOfUrl(url), want = docUrl(url)
    for (let n = el, i = 0; n instanceof Element && i < 4; n = n.parentElement, i++) {
      for (const { value } of n.attributes) {
        if (/^(https?:)?\/\//.test(value) && siteOfUrl(value) === dest) return true
        if (/^\.{0,2}\/[^/]/.test(value) && docUrl(value) === want) return true
      }
    }
    return false
  }

  // The URL of the real link under el, or null (pseudo links like href="#" don't count).
  const linkUnder = el => {
    const a = anchorOf(el)
    if (!a) return null
    try {
      const u = new URL(last?.anchor === a && last.href ? last.href : a.href, location.href)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      if (isThisPage(u.href)) return null
      return u
    } catch { return null }
  }

  function popupAllowed(url) {
    if (url === '' || url == null) url = 'about:blank' // window.open('') opens a blank window
    const raw = url, target = unwrap(url), dest = siteOfUrl(target)
    const el = recent(5000)
    if (el && announced(target)) return true
    const link = el && linkUnder(el)
    if (dest && isThisPage(target)) return !!link && isThisPage(link.href) // tab-under: a copy of this page
    if (!el) return false
    if (link) return docUrl(link.href) === docUrl(raw) || (dest !== null && siteOf(link.hostname) === dest)
    const control = el.closest(CONTROL)
    if (!control) return false // clicking blank space never opens anything
    if (namesDestination(control, raw)) return true
    if (catchAll) return target === raw && trustedDest(target) // a click-anywhere script
    if (dest === null || dest === here()) return true // e.g. a print view or about:blank from a button
    return target === raw && trustedDest(target)
  }

  function navigationAllowed(url, userInitiated) {
    const raw = url, dest = siteOfUrl(unwrap(url))
    if (!dest || dest === here()) return true
    if (announced(raw)) return true // sign-in / checkout flows sending you back
    if (userInitiated) {
      // A real link click, unless the link was re-pointed elsewhere after the press began.
      const pressed = last?.href && performance.now() - last.t < 2000 ? last.href : null
      return !pressed || docUrl(pressed) === docUrl(raw) || siteOfUrl(unwrap(pressed)) === dest
    }
    const el = recent(10000)
    if (!el) return !interacted && !catchAll && performance.now() < 3000 // a pure redirect page
    const link = linkUnder(el)
    if (link) return docUrl(link.href) === docUrl(raw) || siteOfUrl(unwrap(link.href)) === dest
    const control = el.closest(CONTROL)
    if (!control) return false
    if (namesDestination(control, raw)) return true
    // The button's own handler may leave the site; a click-anywhere script may not.
    const fromCatchAll = catchAll > 0 || performance.now() - asyncCatchAllAt < 10000
    return !fromCatchAll && hasOwner(el)
  }

  // ---- invisible traps over the page ----
  const big = el => { const r = el.getBoundingClientRect(); return r.width * r.height >= 0.4 * innerWidth * innerHeight }
  const positioned = el => { const p = getComputedStyle(el).position; return p === 'fixed' || p === 'absolute' }
  const opacity = el => { let o = 1; for (let n = el; n instanceof Element; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o }

  const invisible = el => opacity(el) < 0.1
  // Nothing visible on it: no text, no media except stretched tracking pixels.
  const tinyImage = m => m instanceof HTMLImageElement && m.complete && m.naturalWidth <= 2 && m.naturalHeight <= 2
  const looksEmpty = el => !el.textContent.trim() && [...el.querySelectorAll(MEDIA)].every(tinyImage)

  // A large positioned layer you can't see (at or above el), or null.
  function emptyLayer(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (!positioned(n) || !big(n)) continue
      return looksEmpty(n) || invisible(n) ? n : null
    }
    return null
  }

  const isFrame = el => el instanceof HTMLIFrameElement || el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement
  // A text-less link to another site over a good part of a video player: a fake play button.
  function coversPlayer(a) {
    if (a.textContent.trim()) return false
    const r = a.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const under = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      .find(e => (e instanceof HTMLVideoElement || isFrame(e)) && !a.contains(e))
    if (!under) return false
    const p = under.getBoundingClientRect()
    return r.width * r.height >= 0.2 * p.width * p.height
  }
  // Never legitimate: an invisible frame, or a link to another site that is invisible, empty and
  // page-sized, or sits on a video player as a fake play button.
  function isTrap(el) {
    if (isFrame(el)) return big(el) && invisible(el)
    if (!(el instanceof HTMLAnchorElement) || !siteOfUrl(el.href) || siteOfUrl(el.href) === here() || !positioned(el)) return false
    return (big(el) && (looksEmpty(el) || invisible(el))) || coversPlayer(el)
  }
  // A link to another site wrapped around page content: controls inside it (invalid HTML for a
  // real link), or a quarter of the screen of article text.
  // Product cards (link + button inside) and video previews are small; a wrapper covers the page.
  const wrapsPage = a => {
    const r = a.getBoundingClientRect()
    if (Math.min(r.height, innerHeight) * Math.min(r.width, innerWidth) < 0.35 * innerWidth * innerHeight) return false
    return a.textContent.trim().length > 200 || !!a.querySelector('button,input,select,textarea,video,iframe')
  }
  // Switched off at once; consent walls and payment windows that fade in from fully transparent
  // get their clicks back within a quarter second of becoming visible.
  const disarmed = new Set()
  function disarmTrap(el) {
    if (!(el instanceof Element) || disarmed.has(el) || !isTrap(el)) return
    disarmed.add(el)
    el.style.setProperty('pointer-events', 'none', 'important')
  }
  setInterval(() => {
    for (const el of disarmed) {
      if (!el.isConnected) disarmed.delete(el)
      else if (isFrame(el) && !invisible(el)) { el.style.removeProperty('pointer-events'); disarmed.delete(el) }
    }
  }, 250)
  // Checked as they appear or change, and again as the pointer reaches them.
  const onHover = e => {
    if (!e.isTrusted) return
    disarmTrap(e.target)
    const a = anchorOf(e.target)
    if (a) disarmTrap(a)
  }
  W.addEventListener('pointerover', onHover, true)
  W.addEventListener('mouseover', onHover, true)
  const pending = new Set()
  let scanQueued = false
  const scan = () => {
    scanQueued = false
    for (const f of document.querySelectorAll('iframe,object,embed')) disarmTrap(f)
    pending.forEach(disarmTrap)
    pending.clear()
  }
  new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.type === 'childList' ? r.addedNodes : [r.target]) if (n instanceof HTMLAnchorElement) pending.add(n)
    }
    if (!scanQueued) { scanQueued = true; requestAnimationFrame(scan) }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })

  // ---- the click in progress: finish what the user meant if a hijack was blocked ----
  let click = null
  for (const m of ['stopPropagation', 'stopImmediatePropagation', 'preventDefault']) {
    const orig = Event.prototype[m]
    Event.prototype[m] = disguise(function () {
      if (click && this === click.e) {
        click[m === 'preventDefault' ? 'prevented' : 'stopped'] = true
        if (catchAll) click.byCatchAll = true
      }
      return orig.call(this)
    }, orig)
  }

  let allowOnce = null // a navigation the guard starts itself
  function follow(href, newWindow) {
    if (newWindow) return nativeOpen.call(W, href, '_blank')
    allowOnce = docUrl(href)
    location.assign(href)
  }

  // Replay the click on the element the user actually aimed at.
  function deliver(el, c, fullPress) {
    const a = anchorOf(el)
    if (fullPress && a) return follow(a.href, opensNewWindow(a))
    const init = { bubbles: true, cancelable: true, composed: true, view: W, clientX: c.x, clientY: c.y, button: 0, detail: 1 }
    if (fullPress) {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const ev = type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true, pointerType: 'mouse' }) : new MouseEvent(type, init)
        nativeDispatch.call(el, ev)
      }
      if (el.matches('input,textarea,select,button,[tabindex],[contenteditable]')) el.focus()
    }
    nativeDispatch.call(el, new MouseEvent('click', init))
  }

  function resolve(c) {
    if (!c.blocked || c.resolved) return
    c.resolved = true
    if (c.layer) { // an empty layer took the click: clear it, give the click to what's underneath
      c.layer.style.setProperty('pointer-events', 'none', 'important')
      const under = document.elementFromPoint(c.x, c.y)
      if (under && under !== c.layer && !c.layer.contains(under)) deliver(under, c, true)
    } else if (c.href) { // a real link: go where it pointed
      if (!c.followed && (!c.newWindow || c.prevented)) follow(c.href, c.newWindow)
    } else if (c.stopped || c.prevented) { // the hijacking script swallowed the click
      deliver(c.target, c, false)
    }
  }

  W.addEventListener('click', e => {
    let target = e.composedPath()[0]
    if (!(target instanceof Element)) target = target?.parentElement ?? null
    if (!target) return
    const a = anchorOf(target)
    if (!e.isTrusted) {
      if (a && blockAnchor(a)) e.preventDefault()
      return
    }
    const pressed = last?.anchor === a ? last.href : null
    const c = click = {
      e, target, t: performance.now(), x: e.clientX, y: e.clientY,
      layer: emptyLayer(target), href: a && (pressed ?? a.href), newWindow: !!a && opensNewWindow(a),
      blocked: null, stopped: false, prevented: false, followed: false, done: false, resolved: false,
    }
    if (a) { // watch from the very start of the click whether the page reacts to it at all
      c.watch = new MutationObserver(records => {
        if (records.some(r => !(r.target instanceof Element && r.target.closest('hush-notice')))) c.changed = true
      })
      c.watch.observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
    }
    if (a && pressed && a.href !== pressed && siteOfUrl(a.href) !== siteOfUrl(pressed) && siteOfUrl(a.href) !== here()) {
      a.href = pressed // re-pointed since the press began: put it back before the link activates
    }
    if (a && siteOfUrl(a.href) !== here() && !c.layer && !isTrap(a) && wrapsPage(a)) {
      // The page itself sits inside an ad link: cancel the link, let the click reach what's inside.
      // Nothing to replay afterwards: the page already got this click.
      e.preventDefault()
      c.href = null
      c.resolved = true
      report(c.newWindow ? 'popup' : 'redirect', a.href)
    } else if (a && siteOfUrl(a.href) !== here() && ((c.layer && c.layer.contains(a)) || isTrap(a))) {
      // An empty full-page ad link that the pointer never hovered (touch, keyboard).
      e.preventDefault()
      e.stopImmediatePropagation()
      c.layer ??= a
      c.href = null
      report(c.newWindow ? 'popup' : 'redirect', a.href)
    }
    setTimeout(() => {
      if (click === c) click = null
      c.done = true
      resolve(c)
      // A page-wide script cancelled a click on a real link (e.g. a popunder whose ad didn't load)
      // and then nothing happened: no navigation, no in-page route change. Go where the link points.
      // A lightbox/modal/menu opener cancels link clicks too, but then changes the page; only a
      // page that stays completely unchanged counts.
      if (c.href && c.prevented && c.byCatchAll && !c.blocked) {
        const at = location.href
        setTimeout(() => {
          c.watch.disconnect()
          if (!c.changed && !c.navigated && !c.followed && location.href === at) follow(c.href, c.newWindow)
        }, 1000)
      } else c.watch?.disconnect()
    }, 0)
    recentClick = c
  }, true)
  let recentClick = null

  const report = (kind, url) => {
    // Credit the block to the click that led to it (during it, or shortly after: delayed popups).
    const c = click ?? (recentClick && performance.now() - recentClick.t < 1500 ? recentClick : null)
    if (c && !c.blocked) { c.blocked = kind; if (c.done) resolve(c) }
    let abs = String(url)
    try { abs = new URL(url, location.href).href } catch {}
    tell('__hush_blocked', kind + ' ' + abs)
  }

  // ---- retry storms ----
  // Some players retry a blocked request in a tight loop (CNN's video player: ~1,700 a second),
  // pinning the CPU. After 8 failures within 2 s, the same address is retried at most every 1 s,
  // doubling up to 30 s, until it succeeds.
  const failures = new Map() // origin+path -> { n, since, wait }
  const keyOf = url => { try { const u = new URL(url, location.href); return u.origin + u.pathname } catch { return String(url) } }
  const backoff = key => { const f = failures.get(key); return f && f.n > 8 ? f.wait : 0 }
  const failed = key => {
    const now = performance.now()
    let f = failures.get(key)
    if (!f || (f.n <= 8 && now - f.since > 2000)) f = { n: 0, since: now, wait: 1000 }
    if (++f.n > 9) f.wait = Math.min(f.wait * 2, 30000)
    failures.set(key, f)
  }
  const succeeded = key => failures.delete(key)

  const nativeFetch = W.fetch
  W.fetch = function fetch(input, init) {
    const key = keyOf(typeof input === 'string' ? input : (input?.url ?? String(input)))
    const run = () => nativeFetch.call(this ?? W, input, init).then(r => { succeeded(key); return r }, e => { failed(key); throw e })
    const wait = backoff(key)
    return wait ? new Promise(r => nativeSetTimeout(r, wait)).then(run) : run()
  }
  disguise(W.fetch, nativeFetch)
  const XHR = XMLHttpRequest.prototype
  const nativeXhrOpen = XHR.open, nativeXhrSend = XHR.send
  const xhrState = new WeakMap() // xhr -> { key, async, watched }
  XHR.open = function (method, url, async) {
    xhrState.set(this, { key: keyOf(url), async: async !== false })
    return nativeXhrOpen.apply(this, arguments)
  }
  disguise(XHR.open, nativeXhrOpen)
  XHR.send = function () {
    const st = xhrState.get(this)
    if (!st) return nativeXhrSend.apply(this, arguments)
    if (!st.watched) {
      st.watched = true
      nativeAdd.call(this, 'loadend', () => (this.status === 0 ? failed(st.key) : succeeded(st.key)))
    }
    const wait = st.async ? backoff(st.key) : 0
    if (!wait) return nativeXhrSend.apply(this, arguments)
    const args = arguments
    nativeSetTimeout(() => { try { nativeXhrSend.apply(this, args) } catch {} }, wait)
  }
  disguise(XHR.send, nativeXhrSend)

  // ---- a popup opened blank is about to load `url`: does it fit what the user clicked? ----
  // Capture phase, registered before any page script: at the window, capture listeners run before
  // all others, so a page can't answer first or stop the guard from answering.
  nativeAdd.call(W, '__hush_ask', e => {
    const s = String(e.detail), i = s.indexOf(' ')
    tell('__hush_answer', s.slice(0, i) + ' ' + (popupAllowed(s.slice(i + 1)) ? 1 : 0))
  }, true)

  // ---- popups: window.open ----
  // A blank popup from a button only really opens once it's clear what it's for: written into
  // (print views, receipts) -> opens blank right then; sent to a URL -> opens there if that URL
  // fits the click. Popunder scripts open a blank window and point it at an ad a moment later;
  // that window never appears.
  function deferredBlank(win, orig, args) {
    let real = null
    const pending = {} // opener/name set before the real window exists
    const openReal = url => {
      if (!real) {
        const a = [...args]
        a[0] = url ?? ''
        real = orig.apply(win, a)
        if (real) for (const k in pending) try { real[k] = pending[k] } catch {}
      }
      return real
    }
    const go = url => {
      url = String(url)
      if (!popupAllowed(url)) return report('popup', url)
      if (real) real.location.href = url
      else openReal(url)
    }
    const location = new Proxy({}, {
      get: (_, k) => {
        if (real) { const v = real.location[k]; return typeof v === 'function' ? v.bind(real.location) : v }
        if (k === 'assign' || k === 'replace') return go
        if (k === 'href') return 'about:blank'
        if (k === 'toString') return () => 'about:blank'
        return undefined
      },
      set: (_, k, v) => { if (k === 'href') go(v); else if (real) real.location[k] = v; return true },
    })
    return new Proxy({}, {
      get: (_, k) => {
        if (k === 'location') return location
        if (!real) {
          if (k === 'closed') return false
          if (k === 'close' || k === 'focus' || k === 'blur') return () => {}
          if (k in pending) return pending[k]
        }
        const r = openReal() // anything else (document, postMessage, ...) needs the real window
        if (!r) return undefined
        const v = r[k]
        return typeof v === 'function' ? v.bind(r) : v
      },
      set: (_, k, v) => {
        if (k === 'location') go(v)
        else if (!real && (k === 'opener' || k === 'name')) pending[k] = v
        else { const r = openReal(); if (r) r[k] = v }
        return true
      },
    })
  }

  const patched = new WeakSet()
  const patchOpen = win => {
    if (patched.has(win)) return
    patched.add(win)
    const orig = win.open
    win.open = disguise(function open(url, target) {
      if (!popupAllowed(url ?? '')) { report('popup', url || 'about:blank'); return null }
      const blank = url == null || url === '' || /^about:blank$/i.test(String(url))
      if (blank && !/^_(self|top|parent)$/i.test(target ?? '')) return deferredBlank(win, orig, arguments)
      return orig.apply(this ?? win, arguments)
    }, orig)
  }
  patchOpen(W)

  // document.open(url, name, features) with three arguments opens a window too (and a bare
  // `open(...)` inside an inline onclick="" handler resolves to document.open).
  const nativeDocOpen = Document.prototype.open
  Document.prototype.open = function (url) {
    if (arguments.length >= 3 && !popupAllowed(url ?? '')) { report('popup', url || 'about:blank'); return null }
    return nativeDocOpen.apply(this, arguments)
  }
  disguise(Document.prototype.open, nativeDocOpen)

  // Freshly created same-origin iframes hand out an unpatched window.open; patch on access.
  const cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    ...cw,
    get() {
      const win = cw.get.call(this)
      try { if (win) patchOpen(win) } catch {} // cross-origin
      return win
    },
  })

  // ---- popups: scripted clicks on target=_blank links, forms submitted into a new window ----
  function blockAnchor(a) {
    if (!(a instanceof HTMLAnchorElement) || !opensNewWindow(a) || popupAllowed(a.href)) return false
    report('popup', a.href)
    return true
  }
  const nativeClick = HTMLElement.prototype.click
  HTMLElement.prototype.click = function () {
    if (blockAnchor(this)) return
    return nativeClick.call(this)
  }
  disguise(HTMLElement.prototype.click, nativeClick)
  EventTarget.prototype.dispatchEvent = function (ev) {
    if (ev?.type === 'click' && blockAnchor(this)) return false
    return nativeDispatch.call(this, ev)
  }
  disguise(EventTarget.prototype.dispatchEvent, nativeDispatch)
  // Forms that came with the page, unchanged: bank checks (3-D Secure) and single-sign-on pages
  // post themselves to another site, sometimes seconds after load.
  const originalForms = new WeakMap() // form -> action at load
  nativeAdd.call(document, 'DOMContentLoaded', () => { for (const f of document.forms) originalForms.set(f, f.action) })
  let submitting = null
  for (const m of ['submit', 'requestSubmit']) {
    const orig = HTMLFormElement.prototype[m]
    HTMLFormElement.prototype[m] = disguise(function () {
      if (opensNewWindow(this) && !popupAllowed(this.action)) { report('popup', this.action); return }
      submitting = this
      try { return orig.apply(this, arguments) } finally { submitting = null }
    }, orig)
  }
  const pageForm = e => {
    const f = submitting ?? e.sourceElement?.form ?? e.sourceElement?.closest?.('form')
    return !!f && originalForms.get(f) === f.action
  }

  // ---- history stuffing: entries added without a click only replace the current one, so Back works ----
  const nativeReplace = History.prototype.replaceState
  const nativePush = History.prototype.pushState
  History.prototype.pushState = function () {
    return (last && performance.now() - last.t < 1500 ? nativePush : nativeReplace).apply(this, arguments)
  }
  disguise(History.prototype.pushState, nativePush)

  // ---- same-tab redirects: location changes, meta refresh, form.submit(), scripted link clicks ----
  W.navigation?.addEventListener('navigate', e => {
    if (!e.cancelable || e.hashChange || e.downloadRequest != null) return
    if (e.navigationType !== 'push' && e.navigationType !== 'replace') return
    const url = e.destination.url
    if (recentClick && performance.now() - recentClick.t < 2000) recentClick.navigated = true
    if (allowOnce && docUrl(url) === allowOnce) { allowOnce = null; return }
    if ((e.formData && pageForm(e)) || navigationAllowed(url, e.userInitiated)) {
      if (recentClick?.href && docUrl(url) === docUrl(recentClick.href)) recentClick.followed = true
      return
    }
    e.preventDefault()
    report('redirect', url)
  })
})()
