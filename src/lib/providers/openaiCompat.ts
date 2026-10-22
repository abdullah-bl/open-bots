/** Any server that speaks the OpenAI chat-completions format, including tool calls. */
// viaServer: the provider doesn't allow browser requests (no CORS headers), so
// calls go through open-bot's own /api/llm passthrough by default.
export const OPENAI_COMPAT_PRESETS = [
  { id: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', model: 'grok-4', needsKey: true, viaServer: false },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true, viaServer: false },
  { id: 'nvidia', label: 'NVIDIA (build.nvidia.com)', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'z-ai/glm-5.3-flash', needsKey: true, viaServer: true },
  { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true, viaServer: false },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', needsKey: true, viaServer: false },
  { id: 'ollama', label: 'Ollama (this computer)', baseURL: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false, viaServer: false },
  { id: 'custom', label: 'Custom endpoint', baseURL: '', model: '', needsKey: false, viaServer: true },
] as const

export type OpenAICompatPresetId = (typeof OPENAI_COMPAT_PRESETS)[number]['id']

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]

/** Whether calls to this provider go through open-bot's server (never for local servers). */
export function usesServer(presetId: OpenAICompatPresetId, baseURL: string, override?: boolean) {
  if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(baseURL) || baseURL.startsWith('http:')) return false
  return override ?? OPENAI_COMPAT_PRESETS.find((p) => p.id === presetId)?.viaServer ?? true
}
