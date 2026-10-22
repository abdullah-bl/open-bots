// PC keyboard scancodes (set 1) for the key names computer-use models send,
// e.g. "Return", "ctrl+s", "alt+Tab", "Page_Down". Extended keys carry the 0xE0 prefix.

const BASE: Record<string, number> = {
  escape: 0x01, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a,
  '0': 0x0b, minus: 0x0c, equal: 0x0d, backspace: 0x0e, tab: 0x0f,
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19,
  bracketleft: 0x1a, bracketright: 0x1b, return: 0x1c, ctrl: 0x1d,
  a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  semicolon: 0x27, apostrophe: 0x28, grave: 0x29, shift: 0x2a, backslash: 0x2b,
  z: 0x2c, x: 0x2d, c: 0x2e, v: 0x2f, b: 0x30, n: 0x31, m: 0x32, comma: 0x33, period: 0x34, slash: 0x35,
  shift_r: 0x36, kp_multiply: 0x37, alt: 0x38, space: 0x39, caps_lock: 0x3a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44,
  f11: 0x57, f12: 0x58,
}

const EXTENDED: Record<string, number> = {
  home: 0x47, up: 0x48, page_up: 0x49, left: 0x4b, right: 0x4d, end: 0x4f, down: 0x50, page_down: 0x51,
  insert: 0x52, delete: 0x53, super: 0x5b, ctrl_r: 0x1d, alt_r: 0x38, kp_enter: 0x1c, menu: 0x5d,
}

const ALIASES: Record<string, string> = {
  enter: 'return', esc: 'escape', control: 'ctrl', control_l: 'ctrl', ctrl_l: 'ctrl', control_r: 'ctrl_r',
  alt_l: 'alt', meta: 'super', cmd: 'super', win: 'super', super_l: 'super', shift_l: 'shift',
  pageup: 'page_up', prior: 'page_up', pagedown: 'page_down', next: 'page_down', del: 'delete', ins: 'insert',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', back_space: 'backspace',
  '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', ';': 'semicolon', "'": 'apostrophe',
  '`': 'grave', '\\': 'backslash', ',': 'comma', '.': 'period', '/': 'slash', ' ': 'space',
}

function codeFor(name: string): number[] | null {
  const k = ALIASES[name.toLowerCase()] ?? name.toLowerCase()
  if (k in BASE) return [BASE[k]]
  if (k in EXTENDED) return [0xe0, EXTENDED[k]]
  return null
}

/** Press-then-release scancodes for a combo like "ctrl+shift+t". Throws on unknown keys. */
export function comboScancodes(combo: string): number[] {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  // "ctrl++" means ctrl and the plus key, which is shift+equal on a US layout.
  if (combo.endsWith('++')) parts.push('shift', 'equal')
  const codes = parts.map((p) => {
    const c = codeFor(p)
    if (!c) throw new Error(`Unknown key "${p}"`)
    return c
  })
  const press = codes.flat()
  const release = [...codes].reverse().flatMap((c) => (c.length === 2 ? [0xe0, c[1] | 0x80] : [c[0] | 0x80]))
  return [...press, ...release]
}

/** Scancodes to press (not release) a set of modifiers, and to release them afterwards. */
export function modifierScancodes(text: string | undefined): { down: number[]; up: number[] } {
  if (!text) return { down: [], up: [] }
  const codes = text.split('+').map((p) => {
    const c = codeFor(p.trim())
    if (!c) throw new Error(`Unknown modifier "${p}"`)
    return c
  })
  return {
    down: codes.flat(),
    up: [...codes].reverse().flatMap((c) => (c.length === 2 ? [0xe0, c[1] | 0x80] : [c[0] | 0x80])),
  }
}

// US layout: characters that need shift, mapped to the unshifted key.
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: 'minus', '+': 'equal', '{': 'bracketleft', '}': 'bracketright', '|': 'backslash', ':': 'semicolon',
  '"': 'apostrophe', '~': 'grave', '<': 'comma', '>': 'period', '?': 'slash',
}

/** Scancodes that type `text` on a US keyboard. Characters with no key are skipped and reported. */
export function textScancodes(text: string): { codes: number[]; skipped: string[] } {
  const codes: number[] = []
  const skipped: string[] = []
  const shift = BASE.shift
  for (const ch of text) {
    const name = ch === '\n' ? 'return' : ch === '\t' ? 'tab' : SHIFTED[ch] ?? (ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch)
    const needsShift = ch in SHIFTED || (ch >= 'A' && ch <= 'Z')
    const c = codeFor(name)
    if (!c) {
      skipped.push(ch)
      continue
    }
    if (needsShift) codes.push(shift)
    codes.push(...c, ...(c.length === 2 ? [0xe0, c[1] | 0x80] : [c[0] | 0x80]))
    if (needsShift) codes.push(shift | 0x80)
  }
  return { codes, skipped }
}
