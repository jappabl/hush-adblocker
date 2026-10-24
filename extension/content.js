// Isolated-world script in every frame: asks for site-specific hiding CSS, relays what
// guard.js blocked, and (top frame only) shows the "blocked" notice.
(() => {
  const send = msg => chrome.runtime.sendMessage(msg).catch(() => {})

  send({ type: 'cosmetic' })

  addEventListener('__hush_blocked', e => {
    const s = String(e.detail), i = s.indexOf(' ')
    send({ type: 'blocked', kind: s.slice(0, i), url: s.slice(i + 1) })
  }, true)

  // The background asks whether a popup this frame opened blank may go to `url`; the guard decides.
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type !== 'popupCheck') return
    const id = Math.random().toString(36).slice(2)
    const done = ok => { removeEventListener('__hush_answer', onAnswer); clearTimeout(timer); reply(ok) }
    const onAnswer = e => { const [rid, ok] = String(e.detail).split(' '); if (rid === id) done(ok === '1') }
    const timer = setTimeout(() => done(true), 500)
    addEventListener('__hush_answer', onAnswer)
    dispatchEvent(new CustomEvent('__hush_ask', { detail: id + ' ' + msg.url }))
    return true
  })

  if (window !== top) return

  let ui = null, hideTimer = 0, count = 0, lastKind = '', current = null

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'toast') show(msg)
  })

  function build() {
    const host = document.createElement('hush-notice')
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = `
      <style>
        :host { --bg:#1d1d1f; --fg:#f5f5f7; --dim:#a1a1a6; --btn:#ffffff1f; --btn-h:#ffffff33; }
        @media (prefers-color-scheme: light) {
          :host { --bg:#ffffff; --fg:#1d1d1f; --dim:#6e6e73; --btn:#0000000d; --btn-h:#0000001a; }
        }
        .pill {
          display:flex; align-items:center; gap:10px; overflow:hidden; white-space:nowrap;
          font:13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
          color:var(--fg); background:var(--bg); border-radius:999px;
          padding:7px 7px 7px 14px; box-shadow:0 6px 24px #0000002e, 0 0 0 0.5px #00000026;
          opacity:0; transform:translateY(8px) scale(.97);
          transition:opacity .18s ease, transform .18s ease, width .2s ease;
        }
        .pill.on { opacity:1; transform:none; }
        .host { color:var(--dim); max-width:240px; overflow:hidden; text-overflow:ellipsis; }
        button {
          all:unset; cursor:pointer; padding:4px 10px; border-radius:999px; background:var(--btn);
          font-weight:500;
        }
        button:hover { background:var(--btn-h); }
        .x { padding:4px 7px; color:var(--dim); background:transparent; }
      </style>
      <div class="pill" role="status">
        <span class="msg"></span><span class="host"></span>
        <button class="go"></button><button class="x" aria-label="Dismiss">✕</button>
      </div>`
    const pill = root.querySelector('.pill')
    const els = { host, pill, msg: root.querySelector('.msg'), dest: root.querySelector('.host'), go: root.querySelector('.go') }
    els.go.onclick = () => { if (current) send({ type: 'continue', kind: current.kind, url: current.url }); hide() }
    root.querySelector('.x').onclick = hide
    pill.onmouseenter = () => clearTimeout(hideTimer)
    pill.onmouseleave = () => { hideTimer = setTimeout(hide, 2500) }
    return els
  }

  function show({ kind, url, canContinue }) {
    if (!ui) ui = build()
    if (!ui.host.isConnected) (document.body ?? document.documentElement).append(ui.host)
    count = kind === lastKind && ui.pill.classList.contains('on') ? count + 1 : 1
    lastKind = kind
    current = { kind, url }

    const noun = kind === 'popup' ? 'popup' : 'redirect'
    const before = ui.pill.classList.contains('on') ? ui.pill.offsetWidth : 0
    ui.msg.textContent = count > 1 ? `Blocked ${count} ${noun}s` : `Blocked ${noun}`
    let host = url
    try { host = new URL(url).hostname.replace(/^www\./, '') || url } catch {}
    ui.dest.textContent = host
    ui.go.textContent = kind === 'popup' ? 'Open' : 'Go anyway'
    ui.go.hidden = !canContinue

    // Grow/shrink from the old width instead of snapping.
    ui.pill.style.width = ''
    const after = ui.pill.scrollWidth
    if (before && before !== after) {
      ui.pill.style.width = before + 'px'
      ui.pill.offsetWidth // commit the start width before transitioning
      ui.pill.style.width = after + 'px'
    }
    requestAnimationFrame(() => ui.pill.classList.add('on'))
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, 6000)
  }

  function hide() {
    clearTimeout(hideTimer)
    if (!ui) return
    ui.pill.classList.remove('on')
    setTimeout(() => { if (!ui.pill.classList.contains('on')) ui.host.remove() }, 200)
  }
})()
