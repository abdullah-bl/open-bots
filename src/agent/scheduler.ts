import type { Schedule } from './types'

/** Next time a schedule is due, strictly after `from`. */
export function computeNextRun(s: Schedule, from: number): number {
  if (s.everyMinutes > 0) return from + s.everyMinutes * 60_000
  const [h, m] = (s.dailyAt ?? '09:00').split(':').map(Number)
  const next = new Date(from)
  next.setHours(h, m, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export function describeSchedule(s: Schedule) {
  return s.everyMinutes > 0 ? `every ${s.everyMinutes} min` : `daily at ${s.dailyAt}`
}
