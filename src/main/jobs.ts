import type { Job } from '@shared/types'
import { emit } from './events'
import { getJobRaw, updateJob } from './repo'
import { cancelRequest } from './services/higgsfield'
import { getSettings } from './settings'

export type QueueName = 'higgsfield' | 'tts' | 'whisper' | 'export' | 'ninerouter-image'

export interface TaskCtx {
  jobId: string
  signal: AbortSignal
  progress(p: number, message?: string): void
  setRemote(id: string): void
}

/** A task returns the id of the asset it produced, or a message to keep on the finished job (e.g. an output path). */
export type Task = (ctx: TaskCtx) => Promise<string | void | { message: string }>

// Whisper uses most CPU cores by itself, so it runs one file at a time.
const LIMITS: Record<QueueName, number> = { higgsfield: 3, tts: 2, whisper: 1, export: 1, 'ninerouter-image': 5 }
const running: Record<QueueName, number> = { higgsfield: 0, tts: 0, whisper: 0, export: 0, 'ninerouter-image': 0 }
const waiting: Record<QueueName, (() => void)[]> = { higgsfield: [], tts: [], whisper: [], export: [], 'ninerouter-image': [] }
const controllers = new Map<string, AbortController>()

function getLimit(q: QueueName): number {
  if (q === 'ninerouter-image') {
    try {
      const custom = getSettings().nineRouterImageConcurrency
      return Math.max(1, Math.min(50, Number(custom) || 5))
    } catch {
      return LIMITS[q]
    }
  }
  return LIMITS[q] ?? 1
}

function acquire(q: QueueName): Promise<void> {
  const limit = getLimit(q)
  if (running[q] < limit) {
    running[q]++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    waiting[q].push(() => {
      running[q]++
      resolve()
    })
  )
}

function release(q: QueueName): void {
  running[q]--
  const limit = getLimit(q)
  while (running[q] < limit && waiting[q].length > 0) {
    waiting[q].shift()?.()
  }
}

export function runJob(job: Job, queue: QueueName, task: Task): Job {
  const ctrl = new AbortController()
  controllers.set(job.id, ctrl)
  let lastEmit = 0
  const ctx: TaskCtx = {
    jobId: job.id,
    signal: ctrl.signal,
    progress: (p, message) => {
      const now = Date.now()
      const j = updateJob(job.id, { progress: Math.min(0.99, Math.max(0, p)), ...(message !== undefined ? { message } : {}) })
      if (now - lastEmit > 250 || p >= 0.99) {
        lastEmit = now
        emit.job(j)
      }
    },
    setRemote: (id) => {
      updateJob(job.id, { remoteId: id })
    }
  }
  void (async () => {
    await acquire(queue)
    if (ctrl.signal.aborted) {
      release(queue)
      controllers.delete(job.id)
      emit.job(updateJob(job.id, { status: 'canceled', message: null }))
      return
    }
    try {
      emit.job(updateJob(job.id, { status: 'running', progress: 0.02 }))
      const result = await task(ctx)
      const extra =
        typeof result === 'string' ? { resultAssetId: result, message: null } : { message: result?.message ?? null }
      emit.job(updateJob(job.id, { status: 'done', progress: 1, ...extra }))
    } catch (e) {
      const canceled = ctrl.signal.aborted
      emit.job(
        updateJob(job.id, {
          status: canceled ? 'canceled' : 'failed',
          error: canceled ? null : ((e as Error)?.message ?? String(e)),
          message: null
        })
      )
      if (!canceled) console.error(`[job ${job.kind}]`, e)
    } finally {
      release(queue)
      controllers.delete(job.id)
    }
  })()
  return job
}

export async function cancelJob(id: string): Promise<void> {
  const raw = getJobRaw(id)
  if (!raw) return
  if (raw.remote_id && raw.provider === 'higgsfield') await cancelRequest(raw.remote_id)
  const ctrl = controllers.get(id)
  if (ctrl) ctrl.abort()
  else if (raw.status === 'queued' || raw.status === 'running') emit.job(updateJob(id, { status: 'canceled', message: null }))
}

export function isActive(id: string): boolean {
  return controllers.has(id)
}
