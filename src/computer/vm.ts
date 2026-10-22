// The bots' shared computer: Tiny Core Linux on v86, an x86 PC emulated in
// WebAssembly inside this tab. It has no network card, so nothing it does
// leaves the browser. Screenshots come from its screen canvas; mouse and
// keyboard actions are fed in as emulated PS/2 and VMware-mouse input.
import type { V86 } from 'v86'
import { comboScancodes, modifierScancodes, textScancodes } from './keys'
import { wispUrl } from '../lib/settings'
import { tcpTick } from './tcpfix'

export type VMState = 'off' | 'loading' | 'booting' | 'ready' | 'error'

export interface VMStatus {
  state: VMState
  message?: string
  width: number
  height: number
  /** True while a person (not a bot) is driving the mouse and keyboard. */
  userControl: boolean
  hasSnapshot: boolean
}

export interface Screenshot {
  data: string
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

const ASSETS = '/vm/'
// Bump the version whenever the machine's hardware changes: a snapshot only
// restores onto the hardware it was saved from. v2 added a network card and 256 MB;
// v3 switched that card from NE2000 to virtio-net.
const SNAPSHOT_FILE = 'vm-snapshot-v3.bin'
const OLD_SNAPSHOTS = ['vm-snapshot.bin', 'vm-snapshot-v2.bin']
const MEMORY_MB = 256
/** Long edge we never exceed in screenshots, so every model's image limits are met. */
const MAX_SHOT_EDGE = 1280
/** Gap between relative mouse events; closer events get merged by the guest. */
const PULSE_GAP_MS = 25

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Bus = { send(event: string, data: unknown): void }

/** The runtime takes a per-key delay (ms) that the published typings leave out. */
type PacedInput = {
  keyboard_send_scancodes(codes: number[], delayMs?: number): Promise<void>
}

class ComputerVM {
  status: VMStatus = { state: 'off', width: 0, height: 0, userControl: false, hasSnapshot: false }
  /** v86 draws into this; the UI moves it into view and back. */
  readonly screen: HTMLDivElement
  private emulator: V86 | null = null
  private listeners = new Set<(s: VMStatus) => void>()
  private absoluteMouse = false
  private graphical = false
  private booted: Promise<void> | null = null
  /** Serializes actions so two bots (or a bot and a snapshot) never interleave input. */
  private queue: Promise<unknown> = Promise.resolve()
  private internet = true

  /** Takes effect on the next start (the relay is chosen when the machine boots). */
  setInternet(on: boolean) {
    this.internet = on
  }

  constructor() {
    this.screen = document.createElement('div')
    this.screen.className = 'vm-screen'
    // The structure v86 expects: a text layer and a canvas.
    this.screen.innerHTML = '<div style="white-space:pre;font:14px monospace;line-height:14px"></div><canvas></canvas>'
    const parking = document.createElement('div')
    parking.className = 'vm-parking'
    parking.append(this.screen)
    document.body.append(parking)
    void this.hasSnapshot().then((has) => this.set({ hasSnapshot: has }))
  }

  subscribe(fn: (s: VMStatus) => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private set(patch: Partial<VMStatus>) {
    this.status = { ...this.status, ...patch }
    this.listeners.forEach((fn) => fn(this.status))
  }

  private get canvas() {
    return this.screen.querySelector('canvas')!
  }

  private get input(): PacedInput {
    return this.emulator as unknown as PacedInput
  }

  private get bus(): Bus {
    return (this.emulator as unknown as { bus: Bus }).bus
  }

  /** Boots the computer (or resumes the saved snapshot). Resolves once the desktop is up. */
  start(): Promise<void> {
    this.booted ??= this.boot().catch((err) => {
      this.booted = null
      this.set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      throw err
    })
    return this.booted
  }

  private async boot() {
    this.set({ state: 'loading', message: 'Loading the emulator' })
    const missing = await fetch(`${ASSETS}tinycore.iso`, { method: 'HEAD' }).then((r) => !r.ok || !r.headers.get('content-type')?.match(/octet|iso|binary/))
    if (missing) throw new Error('The Linux image is missing. Run `npm run vm:fetch` once, then reload.')

    const [{ V86: V86Ctor }, { default: wasmUrl }] = await Promise.all([import('v86'), import('v86/build/v86.wasm?url')])
    const snapshot = await this.readSnapshot()

    this.emulator = new V86Ctor({
      wasm_path: wasmUrl,
      memory_size: MEMORY_MB * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      bios: { url: `${ASSETS}seabios.bin` },
      vga_bios: { url: `${ASSETS}vgabios.bin` },
      cdrom: { url: `${ASSETS}tinycore.iso` },
      // A virtio-net card (much faster than the emulated NE2000) that the guest's
      // DHCP picks up; v86 turns its traffic into WISP streams to our relay and
      // resolves DNS over HTTPS.
      net_device: { type: 'virtio', relay_url: wispUrl(!this.internet).replace(/^ws/, 'wisp') },
      screen: { container: this.screen, use_graphical_text: true },
      ...(snapshot ? { initial_state: { buffer: snapshot } } : {}),
      autostart: true,
      // A restored guest still uses the network card's MAC from its snapshot;
      // keep that MAC so the network adapter answers it (otherwise ARP fails).
      ...({ preserve_mac_from_state_image: true } as object),
    })
    const emu = this.emulator
    // Input only reaches the VM when a person takes over; bots inject it directly.
    emu.add_listener('emulator-ready', () => {
      emu.keyboard_set_enabled(false)
      emu.mouse_set_enabled(false)
    })
    emu.add_listener('vmware-absolute-mouse', (on) => {
      this.absoluteMouse = on
    })
    emu.add_listener('screen-set-size', ([w, h, bpp]) => {
      this.graphical = bpp > 0
      if (this.graphical) this.set({ width: w, height: h })
    })
    this.startTcpWatchdog()
    emu.add_listener('download-progress', (p) => {
      if (p.lengthComputable) this.set({ message: `Loading ${p.file_name.split('/').pop()} (${Math.round((p.loaded / p.total) * 100)}%)` })
    })

    await new Promise<void>((resolve) => emu.add_listener('emulator-started', () => resolve()))
    this.set({ state: 'booting', message: snapshot ? 'Resuming saved computer' : 'Booting Linux (about a minute the first time)' })
    if (!snapshot) {
      // Skip the boot menu's countdown; Enter picks the default desktop entry.
      for (const at of [5000, 9000]) setTimeout(() => void this.input.keyboard_send_scancodes([0x1c, 0x9c]), at)
      await this.waitForDesktop()
      await this.waitForPointer()
      // Save the freshly booted machine so every later start resumes in about a second.
      this.set({ message: 'Saving a snapshot for fast starts' })
      await this.writeSnapshot(await emu.save_state()).catch(() => {})
    } else await sleep(800)
    this.set({ state: 'ready', message: undefined, width: this.canvas.width, height: this.canvas.height })
  }

  /**
   * X ignores the mouse for a while after the desktop first appears. Nudge the
   * pointer until the screen shows it moving, so the first real action lands.
   */
  private async waitForPointer() {
    const deadline = Date.now() + 90_000
    let dir = 1
    while (Date.now() < deadline) {
      const before = this.pixels()
      for (let i = 0; i < 4; i++) await this.pulse(4 * dir, 0)
      await sleep(200)
      if (changedPixels(before, this.pixels()) > 10) return
      dir = -dir
      await sleep(1500)
    }
  }

  private pixels(): ImageData {
    const c = this.canvas
    const o = document.createElement('canvas')
    o.width = c.width
    o.height = c.height
    const ctx = o.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(c, 0, 0)
    return ctx.getImageData(0, 0, c.width, c.height)
  }

  private watchdog: ReturnType<typeof setInterval> | null = null
  private tcpPatched = new WeakSet<object>()

  /** Fixes and drives v86's guest TCP (see tcpfix.ts): a send window plus retransmission. */
  private startTcpWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = setInterval(() => {
      tcpTick((this.emulator as unknown as { network_adapter?: Parameters<typeof tcpTick>[0] })?.network_adapter, this.tcpPatched)
    }, 50)
  }

  /** Tiny Core switches to a 1024x768 X desktop; wait for that, then for it to settle. */
  private async waitForDesktop() {
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      if (this.graphical && this.canvas.width >= 640) {
        await sleep(6000)
        return
      }
      await sleep(500)
    }
    throw new Error('Linux did not reach its desktop within 4 minutes.')
  }

  async stop() {
    this.setUserControl(false)
    this.cursor = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    await this.emulator?.destroy().catch(() => {})
    this.emulator = null
    this.booted = null
    this.absoluteMouse = false
    this.graphical = false
    this.set({ state: 'off', message: undefined })
  }

  /** Restarts from scratch (or from the snapshot). */
  async restart() {
    await this.stop()
    await this.start()
  }

  setUserControl(on: boolean) {
    this.emulator?.keyboard_set_enabled(on)
    this.emulator?.mouse_set_enabled(on)
    this.set({ userControl: on && !!this.emulator })
  }

  /* ───────────── snapshots (OPFS) ───────────── */

  private async snapshotHandle(create: boolean) {
    const root = await navigator.storage.getDirectory()
    return root.getFileHandle(SNAPSHOT_FILE, { create })
  }

  private async hasSnapshot() {
    // Snapshots from older hardware can't be restored; free their space.
    const root = await navigator.storage.getDirectory()
    for (const name of OLD_SNAPSHOTS) await root.removeEntry(name).catch(() => {})
    return this.snapshotHandle(false).then(() => true, () => false)
  }

  private async readSnapshot(): Promise<ArrayBuffer | null> {
    try {
      return await (await (await this.snapshotHandle(false)).getFile()).arrayBuffer()
    } catch {
      return null
    }
  }

  /** Saves the whole machine (memory, screen, devices) so the next start resumes here. */
  saveSnapshot() {
    return this.exclusive(async () => {
      if (!this.emulator || this.status.state !== 'ready') throw new Error('The computer is not running.')
      this.set({ message: 'Saving snapshot' })
      const state = await this.emulator.save_state()
      await this.writeSnapshot(state)
      this.set({ message: undefined })
      return state.byteLength
    })
  }

  private async writeSnapshot(state: ArrayBuffer) {
    const w = await (await this.snapshotHandle(true)).createWritable()
    await w.write(state)
    await w.close()
    this.set({ hasSnapshot: true })
  }

  async deleteSnapshot() {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(SNAPSHOT_FILE).catch(() => {})
    this.set({ hasSnapshot: false })
  }

  /* ───────────── actions ───────────── */

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async ensureReady() {
    if (this.status.state !== 'ready') await this.start()
    if (!this.emulator) throw new Error('The computer is not running.')
  }

  /** The screen as an image in the coordinate space every action uses. */
  screenshot(): Promise<Screenshot> {
    return this.exclusive(async () => {
      await this.ensureReady()
      await sleep(150) // let the last action repaint
      return this.capture()
    })
  }

  private capture(region?: [number, number, number, number]): Screenshot {
    const src = this.canvas
    const [x0, y0, x1, y1] = region ?? [0, 0, src.width, src.height]
    const w = Math.max(1, x1 - x0)
    const h = Math.max(1, y1 - y0)
    // Full screenshots stay at native size (≤1280 wide) so coordinates map 1:1;
    // a zoom is scaled up to that same size for detail.
    const scale = region ? Math.min(src.width / w, src.height / h) : Math.min(1, MAX_SHOT_EDGE / Math.max(w, h))
    const out = document.createElement('canvas')
    out.width = Math.round(w * scale)
    out.height = Math.round(h * scale)
    const ctx = out.getContext('2d')!
    ctx.imageSmoothingEnabled = !!region
    ctx.drawImage(src, x0, y0, w, h, 0, 0, out.width, out.height)
    const data = out.toDataURL('image/png').split(',')[1]
    return { data, mediaType: 'image/png', width: out.width, height: out.height }
  }

  zoom(region: [number, number, number, number]): Promise<Screenshot> {
    return this.exclusive(async () => {
      await this.ensureReady()
      const [x0, y0, x1, y1] = region.map((v) => Math.round(v))
      if (x1 <= x0 || y1 <= y0) throw new Error('region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0')
      return this.capture([this.clampX(x0), this.clampY(y0), this.clampX(x1), this.clampY(y1)])
    })
  }

  private clampX(x: number) {
    return Math.max(0, Math.min(this.canvas.width - 1, Math.round(x)))
  }

  private clampY(y: number) {
    return Math.max(0, Math.min(this.canvas.height - 1, Math.round(y)))
  }

  /** Puts the pointer at (x, y). Exact with the VMware mouse; otherwise homes and steps there. */
  /** Where the bots last put the pointer (a person taking over can move it elsewhere). */
  cursor: [number, number] | null = null

  private async moveTo(x: number, y: number) {
    x = this.clampX(x)
    y = this.clampY(y)
    this.cursor = [x, y]
    if (this.absoluteMouse) {
      this.bus.send('mouse-absolute', [x, y, this.canvas.width, this.canvas.height])
      await sleep(40)
      return
    }
    // Relative PS/2 mouse. Measured against Tiny Core's X server: a motion
    // event of 4 px or less moves the pointer 1:1, a larger one moves it 2x,
    // and events closer than ~20 ms apart merge into one (and get doubled).
    // So: pin the pointer in the top-left corner, then plan exact steps per axis.
    for (let i = 0; i < 9; i++) await this.pulse(-127, -127)
    await this.stepAxis(x, 'x')
    await this.stepAxis(y, 'y')
    await sleep(30)
  }

  /** Moves `distance` px along one axis using big (doubled) jumps, then exact small steps. */
  private async stepAxis(distance: number, axis: 'x' | 'y') {
    const sign = Math.sign(distance)
    let left = Math.abs(distance)
    const send = (n: number) => this.pulse(axis === 'x' ? sign * n : 0, axis === 'y' ? sign * n : 0)
    while (left >= 240) {
      await send(120)
      left -= 240
    }
    if (left >= 10) {
      const n = Math.floor(left / 2)
      await send(n)
      left -= 2 * n
    }
    while (left > 0) {
      const n = Math.min(4, left)
      await send(n)
      left -= n
    }
  }

  /** One motion event (screen-down-positive y), spaced so the guest never merges two. */
  private async pulse(dx: number, dy: number) {
    this.bus.send('mouse-delta', [dx, -dy]) // v86 takes y as up-positive
    await sleep(PULSE_GAP_MS)
  }

  private async buttons(left: boolean, middle: boolean, right: boolean) {
    this.bus.send('mouse-click', [left, middle, right])
    await sleep(35)
  }

  click(opts: { x?: number; y?: number; button: 'left' | 'middle' | 'right'; count: number; modifiers?: string }) {
    return this.exclusive(async () => {
      await this.ensureReady()
      const mods = modifierScancodes(opts.modifiers)
      if (opts.x !== undefined && opts.y !== undefined) await this.moveTo(opts.x, opts.y)
      if (mods.down.length) await this.emulator!.keyboard_send_scancodes(mods.down)
      const b = opts.button
      for (let i = 0; i < opts.count; i++) {
        await this.buttons(b === 'left', b === 'middle', b === 'right')
        await this.buttons(false, false, false)
        await sleep(40)
      }
      if (mods.up.length) await this.emulator!.keyboard_send_scancodes(mods.up)
    })
  }

  move(x: number, y: number) {
    return this.exclusive(async () => {
      await this.ensureReady()
      await this.moveTo(x, y)
    })
  }

  mouseButton(down: boolean) {
    return this.exclusive(async () => {
      await this.ensureReady()
      await this.buttons(down, false, false)
    })
  }

  drag(from: [number, number], to: [number, number], modifiers?: string) {
    return this.exclusive(async () => {
      await this.ensureReady()
      const mods = modifierScancodes(modifiers)
      await this.moveTo(from[0], from[1])
      if (mods.down.length) await this.emulator!.keyboard_send_scancodes(mods.down)
      await this.buttons(true, false, false)
      if (this.absoluteMouse) {
        // A few intermediate points so the guest sees motion, not a jump.
        for (let i = 1; i <= 8; i++) {
          this.bus.send('mouse-absolute', [
            this.clampX(from[0] + ((to[0] - from[0]) * i) / 8),
            this.clampY(from[1] + ((to[1] - from[1]) * i) / 8),
            this.canvas.width,
            this.canvas.height,
          ])
          await sleep(25)
        }
      } else {
        // The button stays held, so step from the start point rather than re-homing.
        await this.stepAxis(this.clampX(to[0]) - this.clampX(from[0]), 'x')
        await this.stepAxis(this.clampY(to[1]) - this.clampY(from[1]), 'y')
      }
      await this.buttons(false, false, false)
      if (mods.up.length) await this.emulator!.keyboard_send_scancodes(mods.up)
    })
  }

  scroll(opts: { x?: number; y?: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number; modifiers?: string }) {
    return this.exclusive(async () => {
      await this.ensureReady()
      const mods = modifierScancodes(opts.modifiers)
      if (opts.x !== undefined && opts.y !== undefined) await this.moveTo(opts.x, opts.y)
      if (mods.down.length) await this.emulator!.keyboard_send_scancodes(mods.down)
      for (let i = 0; i < Math.max(1, Math.min(30, opts.amount)); i++) {
        // PS/2 wheel: v86 takes [vertical, horizontal] with up positive.
        const v = opts.direction === 'up' ? 1 : opts.direction === 'down' ? -1 : 0
        const h = opts.direction === 'left' ? 1 : opts.direction === 'right' ? -1 : 0
        this.bus.send('mouse-wheel', [v, h])
        await sleep(40)
      }
      if (mods.up.length) await this.emulator!.keyboard_send_scancodes(mods.up)
    })
  }

  /** Types text on a US layout. Returns characters that have no key on it. */
  type(text: string) {
    return this.exclusive(async () => {
      await this.ensureReady()
      // Raw scancodes, not v86's keyboard adapter: the adapter stays disabled
      // so it never captures the person's own typing in the app.
      const { codes, skipped } = textScancodes(text)
      await this.input.keyboard_send_scancodes(codes, 4)
      return skipped
    })
  }

  key(combo: string, repeat = 1) {
    return this.exclusive(async () => {
      await this.ensureReady()
      const codes = comboScancodes(combo)
      for (let i = 0; i < Math.max(1, Math.min(100, repeat)); i++) {
        await this.input.keyboard_send_scancodes(codes, 8)
        await sleep(30)
      }
    })
  }

  holdKey(combo: string, seconds: number) {
    return this.exclusive(async () => {
      await this.ensureReady()
      const { down, up } = modifierScancodes(combo)
      await this.emulator!.keyboard_send_scancodes(down)
      await sleep(Math.min(300, seconds) * 1000)
      await this.emulator!.keyboard_send_scancodes(up)
    })
  }
}

function changedPixels(a: ImageData, b: ImageData) {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60) n++
  }
  return n
}

let instance: ComputerVM | null = null

/** The one shared computer, created on first use. */
export function computer() {
  instance ??= new ComputerVM()
  return instance
}
