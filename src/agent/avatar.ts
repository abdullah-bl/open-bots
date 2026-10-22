import type { BotStatus, Turn } from './types'

export type AvatarShape = 'round' | 'square' | 'tv' | 'blob'
export type AvatarEyes = 'dot' | 'oval' | 'visor' | 'happy'
export type AvatarTop = 'single' | 'double' | 'ears' | 'none'

export interface AvatarStyle {
  shape: AvatarShape
  eyes: AvatarEyes
  top: AvatarTop
}

export const AVATAR_SHAPES: AvatarShape[] = ['round', 'square', 'tv', 'blob']
export const AVATAR_EYES: AvatarEyes[] = ['dot', 'oval', 'visor', 'happy']
export const AVATAR_TOPS: AvatarTop[] = ['single', 'double', 'ears', 'none']

/** Small, stable hash so every bot gets the same default look and timing. */
export function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The bot's chosen look, or a default derived from its id. */
export function avatarFor(bot: { id: string; avatar?: AvatarStyle }): AvatarStyle {
  if (bot.avatar) return bot.avatar
  const h = hash(bot.id)
  return {
    shape: AVATAR_SHAPES[h % 4],
    eyes: AVATAR_EYES[(h >>> 3) % 3], // happy eyes are for moods, not a default
    top: AVATAR_TOPS[(h >>> 6) % 4],
  }
}

/**
 * What the avatar is doing. It reads the bot's run status, and whether the
 * latest turn is the model streaming text (talking) or calling tools (working).
 */
export type Mood = 'idle' | 'thinking' | 'working' | 'talking' | 'waiting' | 'error' | 'happy'

export function moodFor(status: BotStatus, turns: Turn[] | undefined): Mood {
  if (status.state === 'waiting') return 'waiting'
  if (status.state === 'error') return 'error'
  if (status.state === 'working') {
    const last = turns?.[turns.length - 1]
    if (last?.kind === 'assistant' && last.text && !last.toolCalls.length) return 'talking'
    return status.step === 'Thinking' || status.step === 'Starting' ? 'thinking' : 'working'
  }
  const last = turns?.[turns.length - 1]
  if (last?.kind === 'assistant' && last.stop === 'error') return 'error'
  return status.state === 'idle' && status.done ? 'happy' : 'idle'
}

export const MOOD_LABEL: Record<Mood, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  talking: 'Writing',
  waiting: 'Needs your OK',
  error: 'Something went wrong',
  happy: 'Done',
}
