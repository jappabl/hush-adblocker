// Renders extension/icons/{16,32,48,128}.png from an inline SVG.
import puppeteer from 'puppeteer'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#1d1d1f"/>
  <circle cx="64" cy="64" r="32" fill="none" stroke="#fff" stroke-width="12"/>
  <path d="M41 87 L87 41" stroke="#fff" stroke-width="12" stroke-linecap="round"/>
</svg>`

const browser = await puppeteer.launch()
const page = await browser.newPage()
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size })
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`)
  await page.screenshot({ path: `extension/icons/${size}.png`, omitBackground: true })
}
await browser.close()
