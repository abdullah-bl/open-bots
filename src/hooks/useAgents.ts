import { useSyncExternalStore } from 'react'
import { agents } from '../agent/manager'

export function useAgents() {
  return useSyncExternalStore(agents.subscribe, agents.getState)
}
