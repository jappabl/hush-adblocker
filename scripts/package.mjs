// Builds dist/hush-<version>.zip: the extension folder as the Chrome Web Store / Edge Add-ons
// upload (minus _metadata/, the cache a browser writes when the folder is loaded unpacked).
// Usage: npm run package   (run `npm run build` first for fresh filter lists)
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')
const { version } = JSON.parse(await fs.readFile(path.join(EXT, 'manifest.json'), 'utf8'))
const out = path.join(ROOT, 'dist', `hush-${version}.zip`)
await fs.mkdir(path.dirname(out), { recursive: true })
await fs.rm(out, { force: true })
execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '*.DS_Store', '-x', '_metadata/*'], { cwd: EXT })
const { size } = await fs.stat(out)
console.log(`${path.relative(ROOT, out)}  ${(size / 1e6).toFixed(1)} MB`)
