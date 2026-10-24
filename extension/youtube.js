// YouTube ads. Runs in the page's own JS world at document_start on YouTube pages and embeds.
//
// 1. Strip the ad schedule (adPlacements / adSlots / playerAds) from every place the player
//    reads it: the inline ytInitialPlayerResponse, fetch and XHR responses, and JSON.parse.
//    Also in fresh iframes, which YouTube uses to get unpatched copies of those functions.
// 2. Drop ad entries from the Shorts feed.
// 3. Fallback for ads that still play: click Skip, mute, fast-forward.
// 4. Undo YouTube's anti-adblock measures: the ~17 s start delay and the
//    "Ad blockers are not allowed" dialog.
// 5. Recover from the stall YouTube causes when it notices ads are missing
//    ("Experiencing interruptions?"): reload the video as a request context that
//    YouTube serves without ads.
//
// Mirrors what uBlock Origin's YouTube filters do (uAssets filters.txt / quick-fixes.txt).
// YouTube changes this regularly; that's where to look when ads come back.
(() => {
  'use strict'
  const W = window
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds']
  const AD_KEY_TEXT = /"(adPlacements|adSlots|playerAds)"/g
  const AD_URL = /\/youtubei\/v1\/(player|get_watch|next|reel\/reel_watch_sequence)\b|\/playlist\?list=|\/watch\?/

  // Wrapped functions report the original's source, so they still look native.
  const originals = new WeakMap()
  const nativeToString = Function.prototype.toString
  const toString = function toString() { return nativeToString.call(originals.get(this) ?? this) }
  originals.set(toString, nativeToString)
  Function.prototype.toString = toString
  const wrap = (obj, key, make) => {
    const orig = obj[key]
    if (typeof orig !== 'function') return
    const w = make(orig)
    originals.set(w, orig)
    obj[key] = w
  }

  // ---------- 1 + 2: remove ads from data ----------

  const strip = r => {
    if (!r || typeof r !== 'object') return
    for (const k of AD_KEYS) if (k in r) delete r[k]
  }
  const notAd = e => !e?.command?.reelWatchEndpoint?.adClientParams?.isAd

  function prune(o) {
    if (!o || typeof o !== 'object') return o
    if (Array.isArray(o)) {
      for (const x of o) strip(x?.playerResponse)
      return o
    }
    strip(o)
    strip(o.playerResponse)
    if (Array.isArray(o.entries)) o.entries = o.entries.filter(notAd)
    const seq = o.reelWatchSequenceResponse
    if (Array.isArray(seq?.entries)) seq.entries = seq.entries.filter(notAd)
    return o
  }
  // Renaming the key (uBO's approach) keeps the JSON valid and is cheaper than a re-parse.
  const fixText = t => (typeof t === 'string' ? t.replace(AD_KEY_TEXT, '"no_ads"') : t)

  // Section 5 marks the context it wants by appending a tag to the client userAgent; the
  // player request is rewritten to match when it is serialized.
  const TAGS = ['channel', 'lactmilli', 'instream', 'yahi']
  function dressRequest(req) {
    const ua = req?.attestationRequest && req.context?.client?.userAgent
    if (typeof ua !== 'string') return
    const has = t => ua.includes(t)
    const client = req.context.client
    const content = req.playbackContext?.contentPlaybackContext
    if (has('channel') && client.clientName === 'WEB') client.clientScreen = 'CHANNEL'
    if (has('lactmilli')) req.params = '8AUB'
    if (has('yahi')) req.params = 'YAHI'
    if (has('instream') && content) req.playbackContext.adPlaybackContext = { adType: 'AD_TYPE_INSTREAM' }
    if (content && /channel|lactmilli|instream/.test(ua)) content.lactMilliseconds = String(Date.now())
    if (content && /adunit|channel|lactmilli|instream|inline|yahi|eafg/.test(ua)) {
      content.referer = String(content.referer ?? '').replace(/(?:#reloadxhr)?$/, '#reloadxhr')
    }
  }

  const patched = new WeakSet()
  function patchRealm(win) {
    if (patched.has(win)) return
    patched.add(win)

    wrap(win.JSON, 'parse', orig => function parse() { return prune(orig.apply(this, arguments)) })
    wrap(win.JSON, 'stringify', orig => function stringify(value) {
      if (value && typeof value === 'object' && value.attestationRequest) dressRequest(value)
      return orig.apply(this, arguments)
    })

    wrap(win, 'fetch', orig => async function fetch(input) {
      const res = await orig.apply(this, arguments)
      const url = typeof input === 'string' ? input : (input?.url ?? String(input))
      if (!AD_URL.test(url)) return res
      const text = await res.clone().text()
      const fixed = fixText(text)
      if (fixed === text) return res
      const out = new win.Response(fixed, { status: res.status, statusText: res.statusText, headers: res.headers })
      Object.defineProperties(out, { url: { value: res.url }, type: { value: res.type }, redirected: { value: res.redirected } })
      return out
    })

    const XHR = win.XMLHttpRequest.prototype
    const urls = new WeakMap()
    wrap(XHR, 'open', orig => function open(method, url) {
      urls.set(this, String(url))
      return orig.apply(this, arguments)
    })
    for (const prop of ['response', 'responseText']) {
      const d = Object.getOwnPropertyDescriptor(XHR, prop)
      const get = function () {
        const v = d.get.call(this)
        if (this.readyState !== 4 || !AD_URL.test(urls.get(this) ?? '')) return v
        if (typeof v === 'string') return fixText(v)
        if (v && typeof v === 'object' && !(v instanceof win.ArrayBuffer) && !(v instanceof win.Blob)) return prune(v)
        return v
      }
      originals.set(get, d.get)
      Object.defineProperty(XHR, prop, { ...d, get })
    }
  }
  patchRealm(W)

  // Same-origin iframes: patch as soon as the page can reach their window.
  const tryPatch = frame => { try { const w = frame.contentWindow; if (w && w.fetch) patchRealm(w) } catch {} }
  const cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    ...cw,
    get() {
      const w = cw.get.call(this)
      try { if (w && w.fetch) patchRealm(w) } catch {} // cross-origin
      return w
    },
  })
  const afterInsert = node => {
    if (node instanceof HTMLIFrameElement) tryPatch(node)
    else if (node?.querySelectorAll) node.querySelectorAll('iframe').forEach(tryPatch)
  }
  for (const [proto, key] of [[Node.prototype, 'appendChild'], [Node.prototype, 'insertBefore'], [Element.prototype, 'append'], [Element.prototype, 'prepend']]) {
    wrap(proto, key, orig => function () {
      const r = orig.apply(this, arguments)
      for (const n of arguments) afterInsert(n)
      return r
    })
  }

  // The inline `var ytInitialPlayerResponse = {...}` assigns through this setter.
  let initial
  Object.defineProperty(W, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => initial,
    set: v => { initial = prune(v) },
  })

  // ---------- 4a: the start delay YouTube adds for ad-block users ----------

  wrap(W, 'setTimeout', orig => function setTimeout(fn, delay) {
    if (delay === 17000 && typeof fn === 'function' && nativeToString.call(fn).includes('[native code]')) {
      arguments[1] = 17
    }
    return orig.apply(this, arguments)
  })

  // ---------- 3: ads that still play ----------

  const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button'
  let saved = null // video state from before the ad

  function onPlayback() {
    const player = document.getElementById('movie_player')
    const video = player?.querySelector('video')
    if (!video) return
    const ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')
    if (ad) {
      player.querySelector(SKIP)?.click()
      saved ??= { muted: video.muted, rate: video.playbackRate }
      video.muted = true
      // Not seeking: ads are usually stitched into the same stream as the video (SABR), so a
      // seek on the <video> lands at the end of the real video, and the player disallows seeking.
      video.playbackRate = 16
    } else if (saved) {
      video.muted = saved.muted
      video.playbackRate = saved.rate
      saved = null
    }
  }
  for (const type of ['loadedmetadata', 'playing', 'timeupdate']) document.addEventListener(type, onPlayback, true)

  // ---------- 4b: "Ad blockers are not allowed on YouTube" ----------

  new MutationObserver(() => {
    const wall = document.querySelector('ytd-enforcement-message-view-model')
    if (!wall) return
    ;(wall.closest('tp-yt-paper-dialog') ?? wall).remove()
    document.querySelector('tp-yt-iron-overlay-backdrop.opened')?.remove()
    document.querySelector('#movie_player video')?.play().catch(() => {})
  }).observe(document, { childList: true, subtree: true })

  // ---------- 5: playback stalls (port of uBO's quick-fixes.txt YouTube script) ----------

  let remaining = TAGS // contexts not tried yet for this video
  let stalled = false
  let baseUA = null
  let reloadedAt = -Infinity
  // Every load starts out looking stuck (empty buffer, 0x0), so give a reload time to start.
  const settling = () => performance.now() - reloadedAt < 3000

  function setTag(tag) {
    const client = W.ytcfg?.data_?.INNERTUBE_CONTEXT?.client
    if (!client) return
    baseUA ??= client.userAgent
    const head = baseUA?.match(/Mozilla\/5\.0 \([^)]+/)?.[0]
    client.userAgent = tag && head ? baseUA.replace(head, `${head}; ${tag}`) : baseUA
  }

  function playerState() {
    const player = document.getElementById('movie_player')
    return {
      player,
      response: player?.getPlayerResponse?.(),
      stats: player?.getStatsForNerds?.(),
      progress: player?.getProgressState?.(),
      buffering: player?.getPlayerStateObject?.()?.isBuffering,
    }
  }
  const looksStalled = s => s.buffering && s.stats?.buffer_health_seconds === '0.00 s' && s.stats?.resolution === '0x0' && remaining.length > 0

  // YouTube's own hints that playback is being held back.
  function stallHint() {
    if (stalled || settling()) return
    const s = playerState()
    if (!s.player || !looksStalled(s)) return
    // Already reloaded with a context and still stuck: that context doesn't work.
    if (s.response?.playbackTracking?.videostatsPlaybackUrl?.baseUrl?.includes('reloadxhr')) remaining = remaining.slice(1)
    stalled = true
  }

  function check() {
    const s = playerState()
    const { player, response, stats, progress } = s
    if (!player || !location.href.includes('/watch?')) { remaining = TAGS; return }
    const playingSomething = (progress?.duration > 0 && (progress.loaded < progress.duration || progress.duration - progress.current > 1)) ||
      response?.videoDetails?.isLive
    if (!playingSomething) return

    if (stats?.debug_info?.startsWith?.('SSAP, AD')) { // stitched-in ad: progress is the ad's
      if (progress?.duration > 0) player.seekTo?.(progress.duration)
      return
    }
    const id = response?.videoDetails?.videoId
    const start = response?.playerConfig?.playbackStartConfig?.startSeconds ?? 0
    const err = response?.playabilityStatus?.errorScreen
    const why = JSON.stringify(err?.playerErrorMessageRenderer?.subreason?.runs ||
      err?.playerInterstitialRenderer?.content?.interstitialViewModel?.description?.commandRuns) ?? ''
    const reload = tag => { setTag(tag); stalled = false; reloadedAt = performance.now(); player.loadVideoById?.(id, start) }

    if (response?.playabilityStatus?.status === 'UNPLAYABLE' && !err?.playerErrorMessageRenderer?.playerCaptchaViewModel &&
        why.includes('WEB_PAGE_TYPE_UNKNOWN') && why.includes('https://support.google.com/youtube/answer/3037019')) {
      remaining = remaining.slice(1) // "not available" for ad-block users: next context
      reload(remaining[0] ?? '')
    } else if (!remaining.length) {
      stalled = false
      setTag('')
    } else if (stalled && !settling() && looksStalled(s)) {
      reload(remaining[0])
    } else if (!stalled && progress.current - start < 5 && location.href.includes('&list=') && player.getPlaylistId?.() === null) {
      // A reload drops the playlist; put it back.
      const manager = document.querySelector('yt-playlist-manager')
      const data = manager?.getPlaylistData?.()
      if (data) {
        manager.setPlaylistData?.(data)
        manager.setPlayerPlaybackControlData?.({ playlistPanelRenderer: data })
      }
    }
  }

  const premium = () => W.ytInitialData?.topbar?.desktopTopbarRenderer?.logo?.topbarLogoRenderer?.iconImage?.iconType === 'YOUTUBE_PREMIUM_LOGO' ||
    document.getElementById('masthead')?.getAttribute('logo-type') === 'YOUTUBE_PREMIUM_LOGO'

  document.addEventListener('DOMContentLoaded', () => {
    if (premium() || location.pathname.startsWith('/embed/') || location.href.startsWith('https://www.youtube.com/tv')) return
    baseUA = W.ytcfg?.data_?.INNERTUBE_CONTEXT?.client?.userAgent ?? null
    let queued = false
    const run = () => { queued = false; try { check() } catch {} }
    run()
    new MutationObserver(() => { if (!queued) { queued = true; setTimeout(run, 200) } })
      .observe(document, { childList: true, subtree: true })
  })

  // The "Experiencing interruptions?" snackbar is looked up through Map#has.
  wrap(Map.prototype, 'has', orig => function has(key) {
    if (key === 'onSnackbarMessage') try { stallHint() } catch {}
    return orig.call(this, key)
  })
  // A 104/105-byte buffer pushed by the streaming client accompanies the stall.
  wrap(Array.prototype, 'push', orig => function push(x) {
    if (x instanceof Uint8Array && (x.length === 104 || x.length === 105) && x.buffer.byteLength === x.length) try { stallHint() } catch {}
    return orig.apply(this, arguments)
  })
  // Neutralize the player's "abnormality detected" handler.
  const isAbnormalityHandler = new WeakMap()
  wrap(Promise.prototype, 'then', orig => function then(onFulfilled) {
    if (typeof onFulfilled === 'function') {
      let hit = isAbnormalityHandler.get(onFulfilled)
      if (hit === undefined) isAbnormalityHandler.set(onFulfilled, hit = nativeToString.call(onFulfilled).includes('onAbnormalityDetected'))
      if (hit) arguments[0] = () => {}
    }
    return orig.apply(this, arguments)
  })
})()
