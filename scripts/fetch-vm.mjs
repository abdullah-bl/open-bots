// Downloads what the in-browser computer needs into public/vm/:
//   - SeaBIOS and the VGA BIOS from the v86 project
//   - Tiny Core Linux 11.0, a 19 MB Linux with an X11 desktop, from its official site
// Run with: npm run vm:fetch
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, '..', 'public', 'vm')

const FILES = [
  { name: 'seabios.bin', url: 'https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin' },
  { name: 'vgabios.bin', url: 'https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin' },
  {
    name: 'tinycore.iso',
    url: 'http://tinycorelinux.net/11.x/x86/archive/11.0/TinyCore-11.0.iso',
    size: 19922944,
    md5Url: 'http://tinycorelinux.net/11.x/x86/archive/11.0/TinyCore-11.0.iso.md5.txt',
  },
]

await mkdir(DIR, { recursive: true })
for (const f of FILES) {
  const path = join(DIR, f.name)
  const have = await stat(path).catch(() => null)
  if (have && (!f.size || have.size === f.size)) {
    console.log(`✓ ${f.name} already present`)
    continue
  }
  process.stdout.write(`↓ ${f.name} from ${f.url} … `)
  const res = await fetch(f.url)
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  if (f.size && data.length !== f.size) throw new Error(`${f.name}: expected ${f.size} bytes, got ${data.length}`)
  if (f.md5Url) {
    // The project publishes "<md5>  <file>"; refuse a download that doesn't match.
    const expected = (await (await fetch(f.md5Url)).text()).trim().split(/\s+/)[0]
    const actual = createHash('md5').update(data).digest('hex')
    if (expected !== actual) throw new Error(`${f.name}: MD5 ${actual} does not match published ${expected}`)
  }
  await writeFile(path, data)
  console.log(`${(data.length / 1e6).toFixed(1)} MB, sha256 ${createHash('sha256').update(data).digest('hex').slice(0, 16)}…`)
}
console.log(`Done. Files are in ${DIR}`)
