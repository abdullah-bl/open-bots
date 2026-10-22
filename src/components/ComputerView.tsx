import { useEffect, useRef, useState } from 'react'
import { computer } from '../computer/vm'
import { useComputerStatus } from '../hooks/useComputerStatus'
import { server } from '../lib/server'

/** The live screen of the shared Linux computer, with controls to run it and take over. */
export function ComputerView({ busyBot }: { busyBot: string | null }) {
  const vm = computer()
  const status = useComputerStatus()
  const host = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<string | null>(null)

  // The emulator keeps drawing into one element; show it here, park it when hidden.
  useEffect(() => {
    host.current?.append(vm.screen)
    return () => {
      vm.setUserControl(false)
      document.querySelector('.vm-parking')?.append(vm.screen)
    }
  }, [vm])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setNote(`${label}…`)
    try {
      await fn()
      setNote(null)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    }
  }

  const on = status.state === 'ready'
  const starting = status.state === 'loading' || status.state === 'booting'

  return (
    <div className="computer">
      <div className={`vm-view ${status.userControl ? 'taken' : ''} ${on ? '' : 'off'}`} ref={host}>
        {!on && (
          <div className="vm-overlay">
            {starting ? (
              <>
                <span className="activity-icon spin" />
                <span>{status.message ?? 'Starting'}</span>
              </>
            ) : status.state === 'error' ? (
              <span className="error">{status.message}</span>
            ) : (
              <button className="primary" onClick={() => run('Starting', () => vm.start())}>
                Start the computer
              </button>
            )}
          </div>
        )}
      </div>

      <div className="vm-bar">
        <span className={`vm-dot ${status.state}`} />
        <span className="vm-status">
          {on
            ? status.userControl
              ? 'You are driving: mouse and keyboard go to Linux'
              : busyBot
                ? `${busyBot} may be using it`
                : `Running · ${status.width}×${status.height}`
            : status.state === 'off'
              ? status.hasSnapshot
                ? 'Off · resumes from its snapshot in about a second'
                : 'Off · the first start boots Linux (about 30 s)'
              : status.state === 'error'
                ? 'Error'
                : 'Starting'}
        </span>
      </div>

      {on && (
        <div className="row">
          <button className={status.userControl ? 'primary' : ''} onClick={() => vm.setUserControl(!status.userControl)} aria-pressed={status.userControl}>
            {status.userControl ? 'Give control back' : 'Take over'}
          </button>
          <button onClick={() => run('Saving', () => vm.saveSnapshot())}>Save snapshot</button>
          <button
            onClick={() =>
              run('Saving and stopping', async () => {
                await vm.saveSnapshot()
                await vm.stop()
              })
            }
            title="Saves a snapshot first, so the next start resumes right here"
          >
            Stop
          </button>
        </div>
      )}
      {(on || status.state === 'error') && (
        <button
          className="danger-quiet"
          onClick={() =>
            run('Resetting', async () => {
              await vm.stop()
              await vm.deleteSnapshot()
              await vm.start()
            })
          }
        >
          Reset to a fresh Linux
        </button>
      )}
      {note && <p className="hint">{note}</p>}
      <p className="hint">
        Tiny Core Linux on an x86 emulator (v86) compiled to WebAssembly, running in this tab.{' '}
        {server()
          ? "Its network goes through open-bot's relay to public internet addresses only (when Internet access is on in Settings)."
          : 'It has no internet: that needs an open-bot server (see Settings).'}{' '}
        Bots that have computer use turned on share it. Snapshots are stored in this browser and saved after each bot run.
      </p>
    </div>
  )
}
