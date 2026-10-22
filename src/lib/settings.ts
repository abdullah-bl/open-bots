import { useEffect, useState } from 'react'
import type { OpenAICompatPresetId } from './providers/openaiCompat'

export type CloudKind = 'anthropic' | 'openai-compat'

export interface Settings {
  /** Private mode: every bot runs on-device and nothing leaves this computer. */
  privacy: boolean
  localModel: string
  autoLoadLocal: boolean
  cloud: CloudKind
  anthropicKey: string
  anthropicModel: string
  compatPreset: OpenAICompatPresetId
  compatBaseURL: string
  compatKey: string
  compatModel: string
}

export const DEFAULT_SETTINGS: Settings = {
  privacy: false,
  // Each backend falls back to its own default when this id belongs to the other one.
  localModel: 'Qwen3.5-2B-q4f16_1-MLC',
  autoLoadLocal: false,
  cloud: 'anthropic',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  compatPreset: 'xai',
  compatBaseURL: 'https://api.x.ai/v1',
  compatKey: '',
  compatModel: 'grok-4',
}

const KEY = 'open-bot.settings.v1'

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      // Storage blocked (private mode): settings still work for this tab.
    }
  }, [settings])
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }))
  return [settings, update] as const
}

export function cloudConfigured(s: Settings) {
  if (s.cloud === 'anthropic') return !!s.anthropicKey
  return !!s.compatBaseURL && !!s.compatModel
}
