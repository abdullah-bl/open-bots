import { useSyncExternalStore } from 'react'
import { localEngine } from '../lib/providers/local'

export function useLocalStatus() {
  return useSyncExternalStore(
    (cb) => {
      const off = localEngine.subscribe(cb)
      return () => void off()
    },
    () => localEngine.status,
  )
}
