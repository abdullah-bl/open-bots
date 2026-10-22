import { useEffect, useState } from 'react'
import type { Settings } from '../lib/settings'
import { CLAUDE_MODELS, OPENAI_COMPAT_PRESETS, usesServer, type OpenAICompatPresetId } from '../lib/providers/openaiCompat'
import { localEngine } from '../lib/providers/local'
import { useLocalStatus } from '../hooks/useLocalStatus'
import { defaultServer, resolveServer } from '../lib/server'

type Reach = 'checking' | 'ok' | 'down'

/** Pings the server's health endpoint whenever its address changes. */
function useServerReach(url: string | null) {
  const [reach, setReach] = useState<{ url: string | null; state: Reach }>({ url, state: 'checking' })
  if (reach.url !== url) setReach({ url, state: 'checking' })
  useEffect(() => {
    if (!url) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      fetch(`${url}/api/health`, { signal: abort.signal })
        .then((r) => setReach({ url, state: r.ok ? 'ok' : 'down' }))
        .catch(() => !abort.signal.aborted && setReach({ url, state: 'down' }))
    }, 400)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [url])
  return reach.state
}

export function SettingsPanel(props: { settings: Settings; update: (p: Partial<Settings>) => void; onClose: () => void }) {
  const { settings: s, update } = props
  const status = useLocalStatus()
  const [cached, setCached] = useState<Record<string, boolean>>({})

  const detecting = status.state === 'detecting'
  const gpu = status.state !== 'detecting' && status.backend === 'gpu'
  const models = detecting ? [] : localEngine.models()
  const selected = detecting ? null : localEngine.pick(s.localModel)
  const server = resolveServer(s.serverURL)
  const reach = useServerReach(server)

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
        <h3>open-bot server</h3>
        <p className="hint">
          Web search and page reading (for models other than Claude), the provider passthrough, and internet for the computer and shell run on a
          small server.{' '}
          {defaultServer()
            ? 'Leave this empty to use the one this site came with.'
            : "This site is static and has no server of its own: add one's address to turn these on."}
        </p>
        <label className="lbl">
          Server address
          <input
            className="field"
            value={s.serverURL}
            placeholder={defaultServer() ?? 'https://your-worker.example.workers.dev'}
            onChange={(e) => update({ serverURL: e.target.value.trim() })}
          />
        </label>
        {server ? (
          <p className={`hint server-reach ${reach}`}>
            {reach === 'checking' ? 'Checking…' : reach === 'ok' ? `Connected to ${new URL(server).host}` : `Can't reach ${server}`}
          </p>
        ) : (
          <p className="hint">No server: bots can still use files, the shell, Python, memory, schedules and the computer, all offline.</p>
        )}
      </section>

      <section>
        <h3>Internet for the computer and shell</h3>
        <label className="check">
          <input type="checkbox" checked={s.internet && !!server} disabled={!server} onChange={(e) => update({ internet: e.target.checked })} />
          <span>
            Let the Linux computer and the shell reach the internet
            <span className="hint">
              {server ? '' : 'Needs an open-bot server with a relay. '}
              Traffic goes through open-bot's relay, to public addresses only: your local network, this machine and cloud metadata
              addresses are blocked. DNS lookups go to Cloudflare over HTTPS. The computer picks up a change when it next starts.
            </span>
          </span>
        </label>
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
                  update({ compatPreset: p.id as OpenAICompatPresetId, compatBaseURL: p.baseURL, compatModel: p.model, compatViaServer: undefined })
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
            {!/^http:|^https?:\/\/(localhost|127\.)/i.test(s.compatBaseURL) && (
              <label className="check">
                <input
                  type="checkbox"
                  disabled={!server}
                  checked={!!server && usesServer(s.compatPreset, s.compatBaseURL, s.compatViaServer)}
                  onChange={(e) => update({ compatViaServer: e.target.checked })}
                />
                <span>
                  Send requests through open-bot's server
                  <span className="hint">Needed for providers that block browser requests, such as NVIDIA. {server ? 'Your key passes through the server to the provider.' : 'Set up an open-bot server above first.'}</span>
                </span>
              </label>
            )}
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
