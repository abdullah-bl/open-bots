import { useRef, useState, type KeyboardEvent } from 'react'

export function Composer(props: { busy: boolean; placeholder?: string; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const t = text.trim()
    if (!t || props.busy) return
    props.onSend(t)
    setText('')
    ref.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
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
        <button className="send stop" onClick={props.onStop} aria-label="Stop">
          ■
        </button>
      ) : (
        <button className="send" onClick={submit} disabled={!text.trim()} aria-label="Send">
          ↑
        </button>
      )}
    </div>
  )
}
