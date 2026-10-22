import type { BotStatus } from '../agent/types'

/** A bot's avatar: a colored dot that breathes while it works and rings when it needs you. */
export function Dot({ color, status, size = 14 }: { color: string; status?: BotStatus; size?: number }) {
  const state = status?.state ?? 'idle'
  return (
    <span
      className={`dot dot-${state}`}
      style={{ ['--dot' as string]: color, width: size, height: size }}
      aria-label={state === 'working' ? 'Working' : state === 'waiting' ? 'Needs approval' : state === 'error' ? 'Error' : 'Idle'}
    />
  )
}
