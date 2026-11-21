import type { AtmTaskInput } from '@shared/atm'

/** The server owns the task; page refresh or a lost polling request never restarts it. */
export async function runAtmTask(input: Omit<AtmTaskInput, 'idempotencyKey'>, progress?: (message: string) => void): Promise<unknown> {
  let task = await window.api.atm.startTask({ ...input, idempotencyKey: crypto.randomUUID() })
  while (task.status === 'running') {
    progress?.(task.message)
    await new Promise((resolve) => setTimeout(resolve, 1800))
    task = await window.api.atm.task(task.id)
  }
  if (task.status !== 'done') throw new Error(task.error || task.message || 'Tugas berhenti.')
  return task.result
}
