import type { ToolOutput } from '../agent/types'
import { computer } from './vm'

/**
 * Runs one computer-use action, named as in Claude's computer toolset
 * (`left_click`, `type`, `screenshot`, …). Coordinates are in the pixel space of
 * the screenshots we return, which is the VM's own 1024x768 screen.
 */
export async function runComputerAction(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const vm = computer()
  const point = (key = 'coordinate'): [number, number] | undefined => {
    const v = input[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number')) {
      throw new Error(`${key} must be [x, y]`)
    }
    return [v[0], v[1]]
  }
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const num = (key: string, fallback: number) => (typeof input[key] === 'number' ? (input[key] as number) : fallback)

  const shot = async (): Promise<ToolOutput> => {
    const s = await vm.screenshot()
    return { output: `Screenshot ${s.width}x${s.height}`, image: { data: s.data, mediaType: s.mediaType } }
  }

  switch (name) {
    case 'screenshot':
      return shot()
    case 'zoom': {
      const r = input.region
      if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number')) throw new Error('region must be [x0, y0, x1, y1]')
      const s = await vm.zoom(r as [number, number, number, number])
      return { output: `Zoomed ${r.join(',')}`, image: { data: s.data, mediaType: s.mediaType } }
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const p = point()
      await vm.click({
        x: p?.[0],
        y: p?.[1],
        button: name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left',
        count: name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1,
        modifiers: str('text'),
      })
      return { output: 'OK' }
    }
    case 'left_click_drag': {
      const from = point('start_coordinate')
      const to = point()
      if (!from || !to) throw new Error('left_click_drag needs start_coordinate and coordinate')
      await vm.drag(from, to, str('text'))
      return { output: 'OK' }
    }
    case 'mouse_move': {
      const p = point()
      if (!p) throw new Error('mouse_move needs coordinate')
      await vm.move(p[0], p[1])
      return { output: 'OK' }
    }
    case 'left_mouse_down':
    case 'left_mouse_up':
      await vm.mouseButton(name === 'left_mouse_down')
      return { output: 'OK' }
    case 'cursor_position': {
      const c = vm.cursor
      return { output: c ? `X=${c[0]}, Y=${c[1]}` : 'Unknown: move the mouse first.' }
    }
    case 'scroll': {
      const p = point()
      const dir = str('scroll_direction')
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') throw new Error('scroll_direction must be up, down, left or right')
      await vm.scroll({ x: p?.[0], y: p?.[1], direction: dir, amount: num('scroll_amount', 3), modifiers: str('text') })
      return { output: 'OK' }
    }
    case 'type': {
      const text = str('text')
      if (text === undefined) throw new Error('type needs text')
      const skipped = await vm.type(text)
      return { output: skipped.length ? `Typed, but these characters have no key on the US layout and were skipped: ${[...new Set(skipped)].join(' ')}` : 'OK' }
    }
    case 'key': {
      const text = str('text')
      if (!text) throw new Error('key needs text, e.g. "Return" or "ctrl+s"')
      await vm.key(text, num('repeat', 1))
      return { output: 'OK' }
    }
    case 'hold_key': {
      const text = str('text')
      if (!text) throw new Error('hold_key needs text')
      await vm.holdKey(text, num('duration', 1))
      return { output: 'OK' }
    }
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(300, num('duration', 1)) * 1000))
      return shot()
    default:
      return { output: `Unsupported computer action "${name}".`, isError: true }
  }
}

/** A one-line description of an action for the activity log, e.g. "Click (608, 745)". */
export function describeComputerAction(name: string, input: Record<string, unknown>): string {
  const xy = (v: unknown) => (Array.isArray(v) ? `(${v.join(', ')})` : '')
  switch (name) {
    case 'screenshot':
      return 'Take a screenshot'
    case 'zoom':
      return `Zoom into ${xy(input.region)}`
    case 'left_click':
      return `Click ${xy(input.coordinate)}${input.text ? ` with ${input.text}` : ''}`
    case 'right_click':
      return `Right-click ${xy(input.coordinate)}`
    case 'middle_click':
      return `Middle-click ${xy(input.coordinate)}`
    case 'double_click':
      return `Double-click ${xy(input.coordinate)}`
    case 'triple_click':
      return `Triple-click ${xy(input.coordinate)}`
    case 'left_click_drag':
      return `Drag ${xy(input.start_coordinate)} → ${xy(input.coordinate)}`
    case 'mouse_move':
      return `Move pointer to ${xy(input.coordinate)}`
    case 'scroll':
      return `Scroll ${input.scroll_direction} ×${input.scroll_amount ?? 3}`
    case 'type':
      return `Type "${String(input.text ?? '').slice(0, 60)}"`
    case 'key':
      return `Press ${input.text}${input.repeat && Number(input.repeat) > 1 ? ` ×${input.repeat}` : ''}`
    case 'hold_key':
      return `Hold ${input.text} for ${input.duration}s`
    case 'wait':
      return `Wait ${input.duration ?? 1}s`
    default:
      return name.replace(/_/g, ' ')
  }
}
