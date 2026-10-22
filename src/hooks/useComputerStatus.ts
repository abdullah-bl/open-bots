import { useSyncExternalStore } from 'react'
import { computer } from '../computer/vm'

export function useComputerStatus() {
  const vm = computer()
  return useSyncExternalStore(vm.subscribe.bind(vm), () => vm.status)
}
