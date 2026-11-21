import type { Job, ProjectBundle } from '@shared/types'

/** Subscribe before starting; reconcile over RPC if an SSE event was missed. */
export async function waitForStudioJob(projectId: string, start: () => Promise<Job>, canceled = (): boolean => false): Promise<{ bundle: ProjectBundle; job: Job }> {
  let latest: Job | undefined
  const seen = new Map<string, Job>()
  const stop = window.api.on.job(job => { seen.set(job.id, job) })
  try {
    latest = await start()
    const deadline = Date.now() + 15 * 60 * 1000
    let reconcile = 0
    while (!canceled()) {
      latest = seen.get(latest.id) ?? latest
      if (latest.status === 'failed' || latest.status === 'canceled') throw new Error(latest.error ?? 'Proses audio dihentikan')
      if (latest.status === 'done') return { bundle: await window.api.projects.get(projectId), job: latest }
      if (Date.now() > deadline) throw new Error('Proses audio terlalu lama. Periksa job sebelum mencoba lagi.')
      if (Date.now() > reconcile) {
        const bundle = await window.api.projects.get(projectId)
        latest = bundle.jobs.find(j => j.id === latest!.id) ?? latest
        seen.set(latest.id, latest)
        reconcile = Date.now() + 3000
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw new Error('Permintaan audio sudah berubah')
  } finally { stop() }
}
