/** Any server that speaks the OpenAI chat-completions format, including tool calls. */
export const OPENAI_COMPAT_PRESETS = [
  { id: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', model: 'grok-4', needsKey: true },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true },
  { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', needsKey: true },
  { id: 'ollama', label: 'Ollama (this computer)', baseURL: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
  { id: 'custom', label: 'Custom endpoint', baseURL: '', model: '', needsKey: false },
] as const

export type OpenAICompatPresetId = (typeof OPENAI_COMPAT_PRESETS)[number]['id']

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]
