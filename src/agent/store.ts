import { openDB, type IDBPDatabase } from 'idb'
import type { Bot, Thread } from './types'

// Bots and their threads live in IndexedDB in this browser only.
let dbPromise: Promise<IDBPDatabase> | null = null

function db() {
  dbPromise ??= openDB('open-bot', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) d.createObjectStore('conversations', { keyPath: 'id' })
      if (oldVersion < 2) {
        d.createObjectStore('bots', { keyPath: 'id' })
        d.createObjectStore('threads', { keyPath: 'id' }).createIndex('botId', 'botId')
      }
    },
  })
  return dbPromise
}

export async function loadBots(): Promise<Bot[]> {
  const bots = (await (await db()).getAll('bots')) as Bot[]
  return bots.sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveBot(bot: Bot) {
  await (await db()).put('bots', bot)
}

export async function deleteBotData(botId: string) {
  const d = await db()
  const tx = d.transaction(['bots', 'threads'], 'readwrite')
  await tx.objectStore('bots').delete(botId)
  for (const key of await tx.objectStore('threads').index('botId').getAllKeys(botId)) {
    await tx.objectStore('threads').delete(key)
  }
  await tx.done
}

export async function loadThreads(botId: string): Promise<Thread[]> {
  const threads = (await (await db()).getAllFromIndex('threads', 'botId', botId)) as Thread[]
  return threads.sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveThread(t: Thread) {
  await (await db()).put('threads', t)
}
