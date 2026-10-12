import { EventEmitter } from 'node:events'
import { EVENTS } from '@shared/api'
import type { Asset, CharacterPatchEvent, ClipPatchEvent, Job, WhisperStatus } from '@shared/types'

export const eventBus = new EventEmitter()

let electronBW: any
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  electronBW = require('electron')?.BrowserWindow
} catch {
  electronBW = null
}

function send(channel: string, payload: unknown): void {
  eventBus.emit(channel, payload)

  if (electronBW?.getAllWindows) {
    try {
      for (const w of electronBW.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload)
      }
    } catch {
      // not in electron window context
    }
  }
}

export const emit = {
  job: (job: Job): void => send(EVENTS.job, job),
  clip: (e: ClipPatchEvent): void => send(EVENTS.clip, e),
  character: (e: CharacterPatchEvent): void => send(EVENTS.character, e),
  asset: (asset: Asset): void => send(EVENTS.asset, asset),
  whisper: (status: WhisperStatus): void => send(EVENTS.whisper, status)
}
