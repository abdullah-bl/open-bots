import { useEffect, useState } from 'react'
import type { Settings } from '../lib/settings'
import { CLAUDE_MODELS, OPENAI_COMPAT_PRESETS, type OpenAICompatPresetId } from '../lib/providers/openaiCompat'
import { localEngine } from '../lib/providers/local'
import { useLocalStatus } from '../hooks/useLocalStatus'

export function SettingsPanel(props: { settings: Settings; update: (p: Partial<Settings>) => void; onClose: () => void }) {
  const { settings: s, update } = props
  const status = useLocalStatus()
  const [cached, setCached] = useState<Record<string, boolean>>({})

  const detecting = status.state === 'detecting'
  const gpu = status.state !== 'detecting' && status.backend === 'gpu'
  const models = detecting ? [] : localEngine.models()
  const selected = detecting ? null : localEngine.pick(s.localModel)

  useEffect(() => {
    if (status.state === 'detecting' || status.state === 'loading') return
    Promise.all(localEngine.models().map(async (m) => [m.id, await localEngine.isCached(m.id).catch(() => false)] as const)).then(
      (pairs) => setCached(Object.fromEntries(pairs)),
    )
  }, [status.state])

  const loadedId = status.state === 'ready' ? status.modelId : null
  const busy = status.state === 'loading'

  return (
    <aside className="settings" role="dialog" aria-label="Settings">
      <header>
        <h2>Settings</h2>
        <button className="icon" onClick={props.onClose} aria-label="Close settings">
          ✕
        </button>
      </header>

      <section>
        <h3>On-device model</h3>
        <p className="hint">Used for bots set to on-device, in Private mode, or when no cloud provider is set. Small models handle simple tool use on the CPU engine.</p>
        {detecting || !selected ? (
          <p className="hint">Checking for a GPU…</p>
        ) : (
          <>
            <p className="hint">
              {gpu
                ? 'GPU found: models run through WebGPU (WebLLM). Downloaded once, then they work offline.'
                : 'No usable GPU here, so models run on the CPU through WebAssembly (llama.cpp). Smaller models feel best.'}
            </p>
            <div className="models">
              {models.map((m) => (
                <label key={m.id} className={`model ${selected.id === m.id ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name="local-model"
                    checked={selected.id === m.id}
                    onChange={() => update({ localModel: m.id })}
                  />
                  <span className="model-name">{m.label}</span>
                  <span className="model-note">
                    {m.note} · {(m.sizeMB / 1024).toFixed(1)} GB {gpu ? 'VRAM' : 'download'}
                    {cached[m.id] ? ' · downloaded' : ''}
                    {loadedId === m.id ? ' · loaded' : ''}
                  </span>
                </label>
              ))}
            </div>
            <div className="row">
              <button className="primary" disabled={busy || loadedId === selected.id} onClick={() => localEngine.load(selected.id)}>
                {loadedId === selected.id ? 'Loaded' : cached[selected.id] ? 'Load' : 'Download & load'}
              </button>
              {loadedId && (
                <button onClick={() => localEngine.unload()} disabled={busy}>
                  Unload
                </button>
              )}
            </div>
            {status.state === 'loading' && (
              <div className="progress">
                <div className="bar" style={{ width: `${Math.round(status.progress * 100)}%` }} />
                <p className="hint">{status.text}</p>
              </div>
            )}
            {status.state === 'error' && <p className="hint warn">{status.message}</p>}
            {status.state === 'ready' && !gpu && (
              <p className="hint">Running on {localEngine.cpuThreads()} CPU thread(s).</p>
            )}
            <label className="check">
              <input type="checkbox" checked={s.autoLoadLocal} onChange={(e) => update({ autoLoadLocal: e.target.checked })} />
              Load this model when the app opens (if downloaded)
            </label>
          </>
        )}
      </section>

      <section>
        <h3>Cloud model</h3>
        <p className="hint">Bots run their agent loop on this model. Claude searches and reads the web on its own servers; other providers use open-bot's web proxy.</p>
        <div className="seg">
          <button className={s.cloud === 'anthropic' ? 'on' : ''} onClick={() => update({ cloud: 'anthropic' })}>
            Claude
          </button>
          <button className={s.cloud === 'openai-compat' ? 'on' : ''} onClick={() => update({ cloud: 'openai-compat' })}>
            Grok / OpenAI-compatible
          </button>
        </div>

        {s.cloud === 'anthropic' ? (
          <>
            <label className="lbl">
              Model
              <select className="field" value={s.anthropicModel} onChange={(e) => update({ anthropicModel: e.target.value })}>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lbl">
              API key
              <input
                className="field"
                type="password"
                autoComplete="off"
                value={s.anthropicKey}
                placeholder="sk-ant-…"
                onChange={(e) => update({ anthropicKey: e.target.value.trim() })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="lbl">
              Provider
              <select
                className="field"
                value={s.compatPreset}
                onChange={(e) => {
                  const p = OPENAI_COMPAT_PRESETS.find((x) => x.id === e.target.value)!
                  update({ compatPreset: p.id as OpenAICompatPresetId, compatBaseURL: p.baseURL, compatModel: p.model })
                }}
              >
                {OPENAI_COMPAT_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lbl">
              Base URL
              <input className="field" value={s.compatBaseURL} onChange={(e) => update({ compatBaseURL: e.target.value.trim() })} />
            </label>
            <label className="lbl">
              Model
              <input className="field" value={s.compatModel} onChange={(e) => update({ compatModel: e.target.value.trim() })} />
            </label>
            <label className="lbl">
              API key
              <input
                className="field"
                type="password"
                autoComplete="off"
                value={s.compatKey}
                placeholder={s.compatPreset === 'ollama' ? 'Not needed' : 'Paste your key'}
                onChange={(e) => update({ compatKey: e.target.value.trim() })}
              />
            </label>
            {s.compatPreset === 'ollama' && (
              <p className="hint">Start Ollama with OLLAMA_ORIGINS set to this site's address so the browser may call it.</p>
            )}
          </>
        )}
        <p className="hint">Keys are saved only in this browser and sent straight to the provider. Fine for personal use; a public site should use a proxy.</p>
      </section>
    </aside>
  )
}
