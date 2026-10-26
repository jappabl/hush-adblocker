// Hostile-site benchmark: the click-hijacking tricks ad networks use, each on a page that also has
// a real button, a real link and empty space. Run against any blocker in browsers.mjs.
//
// A hijack scenario passes only if, for every action:
//   - no new tab or window opened (even one that a blocker closes again),
//   - the page did not navigate somewhere the user didn't ask for,
//   - the real button/link did its job on the FIRST click.
// Legit scenarios check the opposite: normal popups and cross-site buttons must still work.
//
// Usage: node test/bench/hostile.mjs [config ...]    (default: all configs)
import http from 'node:http'
import { launch, CONFIGS } from './browsers.mjs'

const PORT = 8077
const SITE = `http://news-site.test:${PORT}`
const AD = `http://adnet-x7q.test:${PORT}/landing` // unknown to every filter list (ad networks rotate domains)
const LISTED = `http://0i0i0i0.com:${PORT}/` // a popunder network that is in EasyList's popup rules
const START = `http://previous-site.test:${PORT}/start` // where Back should return to
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- scenarios ----------
// actions: button = click the real button; blank = click empty space; link = click the real
// same-site link; wait = do nothing for 5 s; type = click a text box and type.
const S = []
const hijack = (id, desc, actions, script, extraHtml = '', host = 'news-site.test') => S.push({ id, desc, actions, script, extraHtml, host, kind: 'hijack' })
const legit = (id, desc, actions, script, extraHtml = '', query = '', host = 'news-site.test') => S.push({ id, desc, actions, script, extraHtml, query, host, kind: 'legit' })

hijack('popup-on-click', 'any click opens an ad tab', ['blank', 'button'],
  `document.addEventListener('click', () => open(AD))`)
hijack('popup-on-mousedown', 'popup on mousedown', ['blank', 'button'],
  `document.addEventListener('mousedown', () => open(AD))`)
hijack('popup-delayed', 'popup a moment after the click', ['blank', 'button'],
  `document.addEventListener('click', () => setTimeout(() => open(AD), 400))`)
hijack('popup-eats-first-click', 'first click opens ad and is swallowed', ['button'],
  `let done = false
   window.addEventListener('click', e => { if (done) return; done = true; e.stopImmediatePropagation(); e.preventDefault(); open(AD) }, true)`)
hijack('overlay-div', 'invisible full-page layer opens ad, then removes itself', ['button'],
  `const o = document.createElement('div')
   o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent'
   o.onclick = () => { open(AD); o.remove() }
   document.body.append(o)`)
hijack('overlay-link', 'invisible full-page ad link', ['button'],
  `const a = document.createElement('a'); a.href = AD; a.target = '_blank'
   a.style.cssText = 'position:fixed;inset:0;z-index:2147483646'
   a.addEventListener('click', () => setTimeout(() => a.remove(), 0))
   document.body.append(a)`)
hijack('overlay-iframe', 'invisible ad iframe over the page', ['button'],
  `const f = document.createElement('iframe'); f.src = '${`http://adframe-k2.test:${PORT}/frame`}'
   f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;opacity:0;z-index:2147483646'
   addEventListener('message', e => { if (e.data === 'remove-overlay') f.remove() })
   document.body.append(f)`)
hijack('background-skin', 'clickable page background (skin ad)', ['margin', 'button'],
  `const a = document.createElement('a'); a.href = AD; a.target = '_blank'
   a.style.cssText = 'position:fixed;inset:0;z-index:0'
   document.body.prepend(a)
   document.querySelector('main').style.cssText += ';position:relative;z-index:1;background:#fff'`)
hijack('tab-under', 'opens this page in a new tab and turns this one into an ad', ['blank', 'button'],
  `document.addEventListener('click', () => { open(location.href); location.href = AD })`)
hijack('click-redirect', 'click anywhere redirects this tab', ['blank', 'button'],
  `document.addEventListener('click', e => { if (!e.target.closest('a,button')) location.href = AD })`)
hijack('redirect-any-click', 'any click, even on a button, redirects this tab', ['button'],
  `document.addEventListener('click', () => { location.href = AD })`)
hijack('redirect-any-click-delayed', 'any click redirects a moment later', ['button'],
  `document.addEventListener('click', () => setTimeout(() => { location.href = AD }, 300))`)
hijack('onclick-property-redirect', 'document.onclick redirects', ['button'],
  `document.onclick = () => { location.href = AD }`)
hijack('window-onclick-redirect', 'window.onclick redirects', ['button'],
  `window.onclick = () => { location.href = AD }`)
hijack('redirect-after-promise', 'any click redirects after a promise (fetch-style)', ['button'],
  `document.addEventListener('click', () => { Promise.resolve().then(() => { location.href = AD }) })`)
hijack('redirect-async-listener', 'async click-anywhere listener redirects after await', ['button'],
  `document.addEventListener('click', async () => { await null; location.href = AD })`)
hijack('redirect-animation-frame', 'any click redirects on the next frame', ['button'],
  `document.addEventListener('click', () => requestAnimationFrame(() => { location.href = AD }))`)
hijack('link-hijack', 'real link sends you to an ad instead', ['link'],
  `document.addEventListener('click', e => { if (e.target.closest('a')) { e.preventDefault(); location.href = AD } })`)
hijack('link-click-swallowed', 'popunder script cancels link clicks (its ad never loaded)', ['link'],
  `document.addEventListener('click', e => { if (e.target.closest('a')) e.preventDefault() }, true)`)
hijack('href-swap', 'link target swapped on mousedown', ['link'],
  `document.addEventListener('mousedown', e => { const a = e.target.closest('a'); if (a) { const h = a.href; a.href = AD; setTimeout(() => a.href = h, 1000) } })`)
hijack('href-swap-newtab', 'new-tab link target swapped on mousedown', ['newtab-link'],
  `document.addEventListener('mousedown', e => { const a = e.target.closest('a'); if (a) { const h = a.href; a.href = AD; setTimeout(() => a.href = h, 1000) } })`)
hijack('scripted-anchor', 'click creates and clicks a hidden ad link', ['blank', 'button'],
  `document.addEventListener('click', () => { const a = document.createElement('a'); a.href = AD; a.target = '_blank'; a.click() })`)
hijack('form-popup', 'click submits a hidden form into a new tab', ['blank', 'button'],
  `document.addEventListener('click', () => { const f = document.createElement('form'); f.action = AD; f.target = '_blank'; document.body.append(f); f.submit() })`)
hijack('fresh-iframe-open', 'popup through a pristine window.open from a new iframe', ['blank', 'button'],
  `document.addEventListener('click', () => { const f = document.createElement('iframe'); f.style.display = 'none'; document.body.append(f); frames[frames.length - 1].open(AD) })`)
hijack('keydown-popup', 'typing opens an ad', ['type'],
  `document.addEventListener('keydown', () => open(AD))`)
hijack('timed-redirect', 'redirects after a few seconds, no click', ['wait'],
  `setTimeout(() => location.href = AD, 3500)`)
hijack('known-network-popup', 'any click opens a known popunder network', ['blank', 'button'],
  `document.addEventListener('click', () => open(LISTED))`)
hijack('known-network-redirect', 'any click redirects to a known popunder network', ['blank'],
  `document.addEventListener('click', e => { if (!e.target.closest('a,button')) location.href = LISTED })`)

hijack('overlay-transparent-image', 'invisible full-page ad link holding a transparent image', ['button'],
  `const a = document.createElement('a'); a.href = AD; a.target = '_blank'
   a.style.cssText = 'position:fixed;inset:0;z-index:2147483646'
   a.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width:100%;height:100%">'
   a.addEventListener('click', () => setTimeout(() => a.remove(), 0))
   document.body.append(a)`)
hijack('overlay-faded-text', 'near-invisible layer with text over the page', ['button'],
  `const o = document.createElement('div'); o.textContent = 'Click to continue'
   o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;opacity:0.01;font-size:40px'
   o.onclick = () => { open(AD); o.remove() }
   document.body.append(o)`)
hijack('overlay-object', 'invisible <object> over the page', ['button'],
  `const f = document.createElement('object'); f.data = '${`http://adframe-k2.test:${PORT}/frame`}'; f.type = 'text/html'
   f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;opacity:0;z-index:2147483646'
   addEventListener('message', e => { if (e.data === 'remove-overlay') f.remove() })
   document.body.append(f)`)
hijack('fake-play-button', 'play icon over the video player is an ad link', ['player'],
  `const a = document.createElement('a'); a.href = AD; a.target = '_blank'
   a.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center'
   a.innerHTML = '<svg width="90" height="90" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#000a"/><path d="M4 3l3 2-3 2z" fill="#fff"/></svg>'
   a.addEventListener('click', () => setTimeout(() => a.remove(), 0))
   document.getElementById('player').append(a)`,
  `<div id="player" style="position:relative;width:560px;height:315px"><iframe src="/player" style="width:100%;height:100%;border:0"></iframe></div>`)
hijack('first-party-popup', 'popup opens a page on this site that forwards to an ad', ['blank', 'button'],
  `document.addEventListener('click', () => open('/go?to=' + encodeURIComponent(AD)))`)
hijack('first-party-redirect', 'click redirects through this site\'s own forwarding page', ['blank', 'button'],
  `document.addEventListener('click', () => { location.href = '/out?url=' + encodeURIComponent(AD) })`)
hijack('trusted-site-bounce', 'popup bounces through google.com to an ad', ['blank', 'button'],
  `document.addEventListener('click', () => open('http://www.google.com:${PORT}/url?q=' + encodeURIComponent(AD)))`)
hijack('back-button-trap', 'history stuffed; Back redirects to an ad', ['back'],
  `for (let i = 0; i < 3; i++) history.pushState({ i }, '', location.href)
   addEventListener('popstate', () => { location.href = AD })`)
hijack('redirect-on-mousemove', 'after a click, moving the mouse redirects', ['button-then-move'],
  `addEventListener('mousemove', () => { if (window.hits) location.href = AD })`)
hijack('rightclick-popup', 'right-click opens an ad', ['rightclick'],
  `document.addEventListener('contextmenu', () => open(AD))`)
hijack('contentdocument-open', 'popup through a new iframe\'s contentDocument.defaultView', ['blank', 'button'],
  `document.addEventListener('click', () => { const f = document.createElement('iframe'); f.style.display = 'none'; document.body.append(f); f.contentDocument.defaultView.open(AD) })`)

hijack('page-wrapped-in-ad-link', 'the whole article sits inside one big ad link', ['blank', 'button'],
  `const a = document.createElement('a'); a.href = AD; a.target = '_blank'; a.style.cssText = 'display:block;color:inherit;text-decoration:none'
   const main = document.querySelector('main'); while (main.firstChild) a.append(main.firstChild); main.append(a)
   for (let i = 0; i < 14; i++) a.insertAdjacentHTML('beforeend', '<p>Article paragraph with plenty of ordinary text that a reader might click on while reading the story.</p>')`)
hijack('other-realm-catch-all', 'click-anywhere redirect registered with an iframe\'s own addEventListener', ['blank', 'button'],
  `const f = document.createElement('iframe'); f.style.display = 'none'; document.body.append(f)
   f.contentWindow.EventTarget.prototype.addEventListener.call(document, 'click', () => { location.href = AD })`)
hijack('open-self-redirect', 'click redirects this tab via open(url, "_self")', ['blank', 'button'],
  `document.addEventListener('click', () => open(AD, '_self'))`)

hijack('document-open-popup', 'popup through document.open(url, name, features)', ['blank', 'button'],
  `document.addEventListener('click', () => document.open(AD, '_blank', ''))`)
hijack('blank-popup-then-ad', 'real button opens a blank popup, then sends it to an ad', ['button'],
  `document.getElementById('real').addEventListener('click', () => { const w = open(''); setTimeout(() => { w.location.href = AD }, 400) })`)

hijack('hijack-on-firebase-hosting', 'click-anywhere pop-up and redirect on a page hosted on Firebase (anyone can publish there)', ['blank', 'button'],
  `document.addEventListener('click', e => { open(AD); if (!e.target.closest('button')) location.href = AD })`, '', 'deals-4u-77.firebaseapp.com')
hijack('popup-to-tenant-site', 'click-anywhere pop-up to a page someone published on web.app', ['blank', 'button'],
  `document.addEventListener('click', () => open('http://free-prize-claim.web.app:${PORT}/claim'))`)

legit('legit-newtab-link', 'normal target=_blank link to another site', ['expect-popup:#ext'], '',
  `<a id="ext" target="_blank" href="http://other-site.test:${PORT}/article">Other site</a>`)
legit('legit-share', 'share button opens x.com', ['expect-popup:#share'], '',
  `<button id="share" onclick="open('http://x.com:${PORT}/intent/post', '_blank', 'width=500,height=400')">Share</button>`)
legit('legit-login', 'Sign in with Google popup', ['expect-popup:#login'], '',
  `<button id="login" onclick="open('http://accounts.google.com:${PORT}/o/oauth2/auth', 'login', 'width=500,height=600')">Sign in with Google</button>`)
legit('legit-checkout', 'checkout button goes to payment site', ['expect-nav:#pay'], '',
  `<button id="pay" onclick="location.href='http://checkout.payments-co.test:${PORT}/pay'">Checkout</button>`)
legit('legit-delegated-checkout', 'checkout button handled by a page-wide (jQuery-style) listener', ['expect-nav:#buy'],
  `document.addEventListener('click', e => { const b = e.target.closest('[data-href]'); if (b) location.href = b.dataset.href })`,
  `<button id="buy" data-href="http://shop-pay.test:${PORT}/checkout">Buy now</button>`)
legit('legit-app-root-checkout', 'React-style app: root container handles the checkout click', ['expect-nav:#rbuy'],
  `document.getElementById('app').addEventListener('click', async e => {
     if (e.target.id === 'rbuy') { await null; location.href = 'http://checkout.payments-co.test:${PORT}/session/abc' } })`,
  `<div id="app"><button id="rbuy">Pay now</button></div>`)
legit('legit-outbound-redirector', 'forum link through the site\'s own /out?url= page', ['expect-nav:#outlink'], '',
  `<a id="outlink" href="/out?url=${encodeURIComponent(`http://other-site.test:${PORT}/thread`)}">External thread</a>`)
legit('legit-spa-back', 'app adds a history entry on click; Back stays in the app', ['expect-spa-back'],
  `document.getElementById('tab2').onclick = () => history.pushState({}, '', '/s/legit-spa-back?tab=2')`,
  `<button id="tab2">Tab 2</button>`)
legit('legit-map-link', '"View larger map" link over a map embed', ['expect-popup:#bigmap'], '',
  `<div style="position:relative;width:560px;height:300px"><iframe src="/player" style="width:100%;height:100%;border:0"></iframe>
   <a id="bigmap" target="_blank" href="http://maps.google.com:${PORT}/?q=x" style="position:absolute;top:8px;left:8px;background:#fff;padding:4px">View larger map</a></div>`)
legit('legit-blank-login-popup', 'sign-in popup opened blank, then sent to Google', ['expect-popup-stays:#slogin'],
  `document.getElementById('slogin').addEventListener('click', () => {
     const w = window.open('', 'auth', 'width=500,height=600'); w.opener = null
     setTimeout(() => { w.location.href = 'http://accounts.google.com:${PORT}/o/oauth2/auth' }, 400) })`,
  `<button id="slogin">Sign in</button>`)
legit('legit-print-popup', 'print view: blank popup that the page writes a receipt into', ['expect-popup-stays:#print'],
  `document.getElementById('print').addEventListener('click', () => {
     const w = window.open('', '_blank', 'width=600,height=500'); w.document.write('<h1>Receipt</h1>'); w.document.close() })`,
  `<button id="print">Print receipt</button>`)
legit('legit-spa-router', 'app router takes over link clicks (no reload)', ['expect-spa-route'],
  `window.spaAlive = true
   document.addEventListener('click', e => { const a = e.target.closest('a'); if (!a || a.target) return
     e.preventDefault(); history.pushState({}, '', a.href); document.querySelector('h1').textContent = 'Routed' })`, '')
legit('legit-lightbox', 'gallery link opens a lightbox instead of navigating', ['expect-lightbox'],
  `document.addEventListener('click', e => { const a = e.target.closest('a.gallery'); if (!a) return
     e.preventDefault(); const box = document.createElement('div'); box.id = 'lightbox'; box.textContent = 'Photo'; document.body.append(box) })`,
  `<a class="gallery" id="photo" href="/photo-large.jpg">Photo</a>`)
// Single sign-in: Google-style pages handle every click with one page-wide listener (jsaction)
// and send you back to the site you're signing into.
legit('legit-sso-return', 'sign-in page: pick account, page-wide handler sends you back to the app', ['expect-nav:#account'],
  `document.addEventListener('click', e => {
     if (e.target.closest('[data-account]')) location.replace(new URL(location.href).searchParams.get('redirect_uri') + '?code=abc') })`,
  `<div id="account" data-account role="link" style="padding:12px;border:1px solid #ccc;width:300px">jane@example.com</div>`,
  `?redirect_uri=${encodeURIComponent(`http://app-site.test:${PORT}/callback`)}`)
legit('legit-sso-auto-return', 'sign-in step that forwards back on its own after a few seconds', ['expect-nav-wait'],
  `setTimeout(() => { location.replace(new URL(location.href).searchParams.get('continue')) }, 4000)`, '',
  `?continue=${encodeURIComponent(`http://app-site.test:${PORT}/done`)}`)
legit('legit-google-page-wide', 'Google page: item handled by a page-wide listener opens another site', ['expect-nav:#gitem'],
  `document.addEventListener('click', e => { if (e.target.closest('#gitem')) location.href = 'http://www.youtube.com:${PORT}/feed' })`,
  `<li id="gitem" style="padding:12px;width:300px;list-style:none;border:1px solid #ccc">YouTube</li>`, '', 'www.google.com')
legit('legit-firebase-popup', 'Sign in with Google via Firebase (popup to project.firebaseapp.com)', ['expect-popup-stays:#fb'], '',
  `<button id="fb" onclick="window.open('http://myapp-123.firebaseapp.com:${PORT}/__/auth/handler?apiKey=x', 'firebaseAuth', 'width=500,height=600')">Continue with Google</button>`)
legit('legit-klarna-popup', 'pay with Klarna: checkout popup', ['expect-popup-stays:#klarna'],
  `document.getElementById('klarna').addEventListener('click', () => window.open('http://pay.klarna.com:${PORT}/checkout', 'klarna', 'width=500,height=700'))`,
  `<button id="klarna">Pay with Klarna</button>`)
legit('legit-3ds-autopost', 'card check: page posts itself to the bank a few seconds after loading', ['expect-nav-wait'],
  `setTimeout(() => document.getElementById('acs').submit(), 3600)`,
  `<form id="acs" method="POST" action="http://secure.bank-acs.test:${PORT}/3ds"><input type="hidden" name="PaReq" value="abc"></form>`)
legit('legit-fade-in-consent', 'cookie wall that fades in from transparent', ['expect-consent-click'],
  `const f = document.createElement('iframe'); f.id = 'cmp'; f.src = '/consent'
   f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;opacity:0;transition:opacity .6s;z-index:99999;background:#fff'
   document.body.append(f); requestAnimationFrame(() => requestAnimationFrame(() => { f.style.opacity = 1 }))
   addEventListener('message', e => { if (e.data === 'accepted') { window.accepted = true; f.remove() } })`)
legit('legit-product-card', 'product card linking to a store, with a button inside', ['expect-nav:#card-link'], '',
  `<a id="card-link" href="http://store-site.test:${PORT}/item/42" style="display:block;width:280px;padding:10px;border:1px solid #ccc">
   <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="260" height="160" style="background:#ddd">
   <div>Wireless headphones, noise cancelling, 30-hour battery, folding design with carry case and charging cable.</div><button>View deal</button></a>`)
legit('legit-menu-backdrop', 'open menu closes on outside click (invisible backdrop)', ['expect-close-menu'],
  `const b = document.createElement('div'); b.id = 'backdrop'
   b.style.cssText = 'position:fixed;inset:0;z-index:1000;background:transparent'
   b.onclick = () => { b.remove(); document.getElementById('menu').remove(); window.menuClosed = true }
   document.body.append(b)`,
  `<div id="menu" style="position:fixed;top:60px;right:40px;z-index:1001;background:#eee;padding:10px">Menu item</div>`)
legit('legit-card-link', 'whole-card link to another site', ['expect-nav:#card'], '',
  `<a id="card" href="http://other-site.test:${PORT}/story" style="display:block;width:600px;height:300px;background:#ddd"></a>`)

const pageFor = s => `<!doctype html><html><head><meta charset="utf-8"><title>${s.id}</title>
<style>body{font:15px system-ui;margin:0}main{max-width:700px;margin:0 auto;padding:30px}
#blank{height:220px}button,a{font:inherit}</style></head><body><main>
<h1>${s.desc}</h1>
<button id="real" onclick="hits++">Real button</button>
<a id="reallink" href="/next">Real link</a>
<a id="newtablink" href="/next-tab" target="_blank">Real new-tab link</a>
<input id="box" placeholder="type here">
<p id="blank"></p>
${s.extraHtml}
</main>
<script>window.hits = 0; const AD = ${JSON.stringify(AD)}, LISTED = ${JSON.stringify(LISTED)}</script>
<script>${s.script}</script>
</body></html>`

const FRAME = `<!doctype html><body style="margin:0;height:100vh"><script>
  document.onclick = () => { open(${JSON.stringify(AD)}); parent.postMessage('remove-overlay', '*') }
</script></body>`

const server = http.createServer((req, res) => {
  const host = req.headers.host.split(':')[0], p = req.url.split('?')[0]
  const q = new URL(req.url, 'http://x').searchParams
  const fwd = (host === 'news-site.test' && (p === '/go' || p === '/out')) || (host === 'www.google.com' && p === '/url')
  if (fwd) { res.writeHead(302, { location: q.get('to') ?? q.get('url') ?? q.get('q') }); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html' })
  const scenario = p.startsWith('/s/') && S.find(s => s.id === p.slice(3))
  if (scenario && host === (scenario.host ?? 'news-site.test')) return res.end(pageFor(scenario))
  if (p === '/frame') return res.end(FRAME)
  if (p === '/consent') return res.end('<!doctype html><body style="margin:0;height:100vh;display:grid;place-items:center;font:20px system-ui"><button onclick="parent.postMessage(\'accepted\', \'*\')" style="width:100vw;height:100vh">Accept cookies</button></body>')
  if (p === '/player') return res.end('<!doctype html><body style="margin:0;background:#111;height:100vh"><script>document.onclick = () => parent.hits++</script></body>')
  res.end(`<!doctype html><title>${host}${p}</title><h1>${host}${p}</h1>`)
})

// ---------- runner ----------

async function runScenario(browser, s) {
  const page = await browser.newPage()
  const opened = []
  const onTarget = async t => { if (t.type() === 'page') opened.push(t) }
  if (process.env.DEBUG) {
    await page.evaluateOnNewDocument(() => {
      window.__dbg = []
      addEventListener('__hush_blocked', e => __dbg.push('blocked ' + e.detail))
      window.navigation?.addEventListener('navigate', e => __dbg.push(`navigate ${e.destination.url} userInitiated=${e.userInitiated}`))
    })
    page.on('framenavigated', f => { if (f === page.mainFrame()) console.log(`    [${s.id}] main frame -> ${f.url()}`) })
  }
  if (s.actions.includes('back')) await page.goto(START, { waitUntil: 'load' })
  const site = `http://${s.host ?? 'news-site.test'}:${PORT}`
  await page.goto(`${site}/s/${s.id}${s.query ?? ''}`, { waitUntil: 'load' })
  await sleep(700)
  const fails = []
  const center = async sel => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
  const offsite = () => !page.url().startsWith(site)

  for (const action of s.actions) {
    if ((offsite() && action !== 'back') || page.isClosed()) break
    browser.on('targetcreated', onTarget)
    opened.length = 0
    const before = page.url()
    const [kind, sel] = action.split(':')
    if (kind === 'button') await page.mouse.click(...await center('#real'))
    else if (kind === 'blank') await page.mouse.click(...await center('#blank'))
    else if (kind === 'margin') await page.mouse.click(60, 450) // outside the article column
    else if (kind === 'link') await page.mouse.click(...await center('#reallink'))
    else if (kind === 'newtab-link') await page.mouse.click(...await center('#newtablink'))
    else if (kind === 'type') { await page.mouse.click(...await center('#box')); await page.keyboard.type('hello') }
    else if (kind === 'wait' || kind === 'expect-nav-wait') await sleep(4500)
    else if (kind === 'player') await page.mouse.click(...await center('#player'))
    else if (kind === 'rightclick') await page.mouse.click(...await center('#blank'), { button: 'right' })
    else if (kind === 'back') await page.goBack({ timeout: 5000 }).catch(() => {})
    else if (kind === 'button-then-move') {
      await page.mouse.click(...await center('#real'))
      for (let i = 0; i < 5; i++) await page.mouse.move(300 + i * 40, 500 + i * 10)
    }
    else if (kind === 'expect-close-menu') await page.mouse.click(...await center('#blank'))
    else if (['expect-spa-back', 'expect-spa-route', 'expect-lightbox', 'expect-consent-click'].includes(kind)) {} // performed while judging
    else await page.mouse.click(...await center(sel))
    await sleep(2000)
    if (process.env.DEBUG) console.log(`    [${s.id}] ${kind}:`, await page.evaluate(() => window.__dbg?.splice(0)).catch(() => 'page gone'))
    browser.off('targetcreated', onTarget)
    const urls = opened.map(t => t.url())
    const lingering = opened.filter(t => browser.targets().includes(t)).length // still an open tab

    if (s.kind === 'hijack') {
      const goodTab = kind === 'newtab-link' && urls.length === 1 && urls[0].endsWith('/next-tab')
      if (urls.length && !goodTab) fails.push(`${kind}: tab opened${lingering ? '' : ' (then closed)'} ${urls.join(' ')}`)
      if (kind === 'newtab-link' && !goodTab) fails.push(`${kind}: real new-tab link didn't open on first click`)
      if (offsite() && kind !== 'back') fails.push(`${kind}: redirected to ${page.url()}`)
      if (kind === 'link' && !page.url().endsWith('/next')) fails.push(`link: real link didn't work on first click (at ${page.url()})`)
      if ((kind === 'button' || kind === 'player' || kind === 'button-then-move') && !offsite()) {
        const hits = await page.evaluate(() => window.hits).catch(() => null)
        if (hits !== 1) fails.push(`${kind}: real ${kind === 'player' ? 'player' : 'button'} needed another click (hits=${hits})`)
      }
      if (kind === 'back') {
        if (page.url() !== START) fails.push(`back: Back didn't leave the site (at ${page.url()})`)
      } else if (offsite() && !fails.some(f => f.includes('redirected'))) fails.push(`${kind}: left the site to ${page.url()}`)
      if (['blank', 'margin', 'type', 'wait', 'rightclick'].includes(kind) && page.url() !== before && !offsite()) fails.push(`${kind}: page changed to ${page.url()}`)
    } else {
      if (kind === 'expect-popup' && !urls.length) fails.push(`${sel}: legit popup was blocked`)
      if (kind === 'expect-popup-stays' && !lingering) fails.push(`${sel}: legit popup was ${urls.length ? 'closed' : 'blocked'}`)
      if ((kind === 'expect-nav' || kind === 'expect-nav-wait') && !offsite()) fails.push(`${sel ?? 'auto'}: legit navigation was blocked`)
      if (kind === 'expect-spa-back') {
        await page.mouse.click(...await center('#tab2')); await sleep(300)
        await page.goBack({ timeout: 4000 }).catch(() => {}); await sleep(500)
        if (!page.url().endsWith('/s/legit-spa-back')) fails.push(`Back did not return within the app (at ${page.url()})`)
      }
      if (kind === 'expect-spa-route') {
        await page.mouse.click(...await center('#reallink')); await sleep(1800)
        const st = await page.evaluate(() => ({ alive: window.spaAlive === true, path: location.pathname })).catch(() => ({}))
        if (!st.alive || st.path !== '/next') fails.push(`app route broken (reloaded: ${!st.alive}, path: ${st.path})`)
      }
      if (kind === 'expect-lightbox') {
        await page.mouse.click(...await center('#photo')); await sleep(1800)
        const st = await page.evaluate(() => ({ box: !!document.getElementById('lightbox'), path: location.pathname })).catch(() => ({}))
        if (!st.box || st.path.endsWith('.jpg')) fails.push(`lightbox broken (navigated to ${st.path})`)
      }
      if (kind === 'expect-consent-click') {
        await sleep(1500)
        await page.mouse.click(640, 450); await sleep(800)
        if (!(await page.evaluate(() => window.accepted).catch(() => false))) fails.push('consent wall could not be clicked')
      }
      if (kind === 'expect-close-menu' && !(await page.evaluate(() => window.menuClosed).catch(() => false))) fails.push('menu did not close on outside click')
    }
    for (const t of opened) await (await t.page().catch(() => null))?.close().catch(() => {})
  }
  await page.close().catch(() => {})
  return fails
}

export async function runHostile(configs = CONFIGS) {
  await new Promise(r => server.listen(PORT, r))
  const table = {}
  const details = {}
  for (const name of configs) {
    const browser = await launch(name, { mapHosts: true })
    for (const s of S.filter(s => !process.env.ONLY || process.env.ONLY.split(',').includes(s.id))) {
      const fails = await runScenario(browser, s).catch(e => [`error: ${e.message}`])
      ;(table[s.id] ??= { kind: s.kind })[name] = fails.length ? '✗' : '✓'
      if (fails.length) (details[name] ??= []).push(`${s.id}: ${fails.join('; ')}`)
    }
    await browser.close()
    const rows = S.filter(s => s.kind === 'hijack' && table[s.id]), ok = rows.filter(s => table[s.id][name] === '✓').length
    const lg = S.filter(s => s.kind === 'legit' && table[s.id]), lok = lg.filter(s => table[s.id][name] === '✓').length
    console.log(`${name}: hijacks stopped ${ok}/${rows.length}, legit still working ${lok}/${lg.length}`)
  }
  server.close()
  return { table, details }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configs = process.argv.slice(2).length ? process.argv.slice(2) : CONFIGS
  const { table, details } = await runHostile(configs)
  console.table(table)
  for (const [name, lines] of Object.entries(details)) console.log(`\n${name} failures:\n  ` + lines.join('\n  '))
}
