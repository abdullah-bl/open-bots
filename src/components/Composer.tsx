import { useRef, useState, type KeyboardEvent } from 'react'

export function Composer(props: {
  busy: boolean
  placeholder?: string
  onSend: (text: string, files: File[]) => void
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [drag, setDrag] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return
    setFiles((cur) => [...cur.filter((f) => !Array.from(list).some((n) => n.name === f.name)), ...Array.from(list)])
  }

  const submit = () => {
    const t = text.trim()
    if ((!t && !files.length) || props.busy) return
    props.onSend(t, files)
    setText('')
    setFiles([])
    ref.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      className={`composer ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDrag(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f) => (
            <span key={f.name} className="chip">
              ▤ {f.name}
              <button className="chip-x" onClick={() => setFiles((cur) => cur.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <input ref={picker} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
        <button className="attach" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files (they go into the bot's workspace)">
          ＋
        </button>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={props.placeholder ?? 'Ask anything…'}
          rows={1}
          autoFocus
        />
        {props.busy ? (
          <button className="send stop" onClick={props.onStop} aria-label="Stop" title="Stop">
            ■
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim() && !files.length} aria-label="Send" title="Send (Enter)">
            ↑
          </button>
        )}
      </div>
      <div className="composer-hint">Enter to send · Shift+Enter for a new line · drop files to attach</div>
    </div>
  )
}
