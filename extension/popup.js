const $ = id => document.getElementById(id)
const plural = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'} blocked on this page` : '')
const ago = t => {
  const h = Math.floor((Date.now() - t) / 3.6e6)
  return h < 1 ? 'less than an hour ago' : h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

;(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    document.body.classList.add('na')
    $('site').textContent = 'Nothing to block on this page'
    return
  }
  const s = await chrome.runtime.sendMessage({ type: 'state', tabId: tab.id, url: tab.url })
  $('site').textContent = s.site
  $('ads').checked = s.ads
  $('guard').checked = s.guard
  $('ads-n').textContent = s.ads ? plural(s.adsBlocked, 'request') : 'Paused on this site'
  $('guard-n').textContent = s.guard ? plural(s.redirectsBlocked, 'redirect') : 'Paused on this site'
  $('lists').textContent = s.listsCheckedAt ? `Filter lists updated ${ago(s.listsCheckedAt)}` : 'Using built-in filter lists'
  $('lifetime').textContent = `${s.lifetime.toLocaleString()} blocked since install`

  for (const [id, which] of [['ads', 'pausedAds'], ['guard', 'pausedGuard']]) {
    $(id).onchange = async e => {
      e.target.disabled = true
      await chrome.runtime.sendMessage({ type: 'toggle', site: s.site, which, on: e.target.checked })
      chrome.tabs.reload(tab.id)
      window.close()
    }
  }
})()
