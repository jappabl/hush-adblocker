// Approximate registrable domain ("site"): news.bbc.co.uk -> bbc.co.uk, a.b.example.com -> example.com.
// guard.js carries its own copy because it runs in the page's world.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'sch'])

function siteOf(host) {
  host = String(host).toLowerCase().replace(/\.$/, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  const p = host.split('.')
  if (p.length <= 2) return host
  const n = p.length
  return p.slice(SECOND_LEVEL.has(p[n - 2]) && p[n - 1].length === 2 ? -3 : -2).join('.')
}

function hostOf(url) {
  try { return new URL(url).hostname } catch { return '' }
}

// example.com and every parent domain of sub.example.com
function domainChain(host) {
  const parts = host.split('.'), out = []
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'))
  return out.length ? out : [host]
}
