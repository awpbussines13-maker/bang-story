import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AtmTask, AtmTaskInput } from '@shared/atm'
import type { Job } from '@shared/types'
import { getDb } from './db'
import { atmExportIsCurrent, atmRenderHash, getAtmProduction, getAtmProductionDetail, getAtmWorkspace, listAtmReferences } from './atmRepo'
import { analyzeAtmReference, analyzeAtmWorkspace, generateAtmPackage } from './atmGeneration'
import { generateAtmThumbnail } from './atmThumbnail'
import { generateScript, generateVisuals } from './story'
import { clipsOf, getAsset, getBundle, getJob, getLatestExportPath, patchClip } from './repo'
import { generateMissingImages } from './generation'
import { generateNarration, realignNarration, syncCaptions } from './narration'
import { soundPlanningNeeded, startSoundPlan } from './soundDesign'
import { getSettings } from './settings'
import { captionNeedsSync } from '@shared/captions'
import { cancelJob } from './jobs'
import { startExport } from './exporter'
import { join } from 'node:path'
import { dataDir } from './paths'
import { withLlmOverride } from './services/llm'
import { inspectCharacterConsistency, startCharacterConsistencyReview } from './characterConsistency'

const controllers = new Map<string, AbortController>()
const taskInputSchema = z.object({
  workspaceId: z.string().uuid(),
  kind: z.enum(['analyze-reference','analyze-workspace','prepare-production','produce-video','generate-package','generate-thumbnail']),
  projectId: z.string().uuid().optional(), referenceId: z.string().uuid().optional(),
  model: z.string().max(100).optional(), idempotencyKey: z.string().min(1).max(200),
  thumbnailProvider: z.enum(['gemini','9router']).optional(),
  llmProvider: z.enum(['gemini','openrouter','groq','custom','9router']).optional(), llmModel: z.string().trim().min(1).max(200).optional()
}).strict().refine((input) => !!input.llmProvider === !!input.llmModel, 'Isi provider dan model LLM bersamaan.')

export function getAtmTask(id: string): AtmTask {
  const row = getDb().prepare('SELECT * FROM atm_tasks WHERE id=?').get(id) as Record<string, any> | undefined
  if (!row) throw new Error('Tugas ATM tidak ditemukan.')
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, kind: row.kind, status: row.status, message: row.message, error: row.error, result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at }
}

export function listAtmTasks(workspaceId: string): AtmTask[] {
  const rows = getDb().prepare('SELECT id FROM atm_tasks WHERE workspace_id=? ORDER BY created_at DESC LIMIT 12').all(workspaceId) as { id: string }[]
  return rows.map((r) => ({ ...getAtmTask(r.id), result: null }))
}

export function recoverAtmTasks(): void {
  getDb().prepare("UPDATE atm_tasks SET status='failed', error='Server dimulai ulang. Hasil tahap yang sudah selesai tersimpan; jalankan tugas baru untuk melanjutkan.', updated_at=? WHERE status='running'").run(Date.now())
}

export function startAtmTask(raw: AtmTaskInput): AtmTask {
  const input = taskInputSchema.parse(raw)
  getAtmWorkspace(input.workspaceId)
  if (input.kind === 'analyze-reference') {
    if (!listAtmReferences(input.workspaceId).some((r) => r.id === input.referenceId)) throw new Error('Referensi bukan milik ruang ATM ini.')
  } else if (input.kind !== 'analyze-workspace') {
    if (!input.projectId || getAtmProduction(input.projectId)?.workspaceId !== input.workspaceId) throw new Error('Project bukan milik ruang ATM ini.')
  }
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const old = getDb().prepare('SELECT id,request_hash FROM atm_tasks WHERE workspace_id=? AND idempotency_key=?').get(input.workspaceId, input.idempotencyKey) as { id: string; request_hash: string } | undefined
  if (old) {
    if (old.request_hash !== hash) throw new Error('Idempotency key ini sudah digunakan untuk permintaan yang berbeda.')
    return getAtmTask(old.id)
  }
  if (input.projectId && getDb().prepare("SELECT id FROM atm_tasks WHERE project_id=? AND status='running'").get(input.projectId)) throw new Error('Project ini sudah memiliki tugas ATM yang berjalan.')
  if (!input.projectId && getDb().prepare("SELECT id FROM atm_tasks WHERE workspace_id=? AND kind=? AND COALESCE(reference_id,'')=? AND status='running'").get(input.workspaceId, input.kind, input.referenceId ?? '')) throw new Error('Analisis ini sedang berjalan. Tunggu tugas yang sudah dimulai.')
  const id = randomUUID(), now = Date.now()
  getDb().prepare('INSERT INTO atm_tasks (id,workspace_id,project_id,reference_id,kind,idempotency_key,request_hash,status,message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.workspaceId, input.projectId ?? null, input.referenceId ?? null, input.kind, input.idempotencyKey, hash, 'running', 'Menyiapkan tugas', now, now)
  const controller = new AbortController()
  controllers.set(id, controller)
  void withLlmOverride(input.llmProvider && input.llmModel ? { provider: input.llmProvider, model: input.llmModel } : null, () =>
    execute(input, controller.signal, (message) => getDb().prepare('UPDATE atm_tasks SET message=?,updated_at=? WHERE id=?').run(message, Date.now(), id)))
    .then((result) => {
      if (!controller.signal.aborted) getDb().prepare("UPDATE atm_tasks SET status='done',message='Selesai',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(result ?? null), Date.now(), id)
    }).catch((e) => {
      if (!controller.signal.aborted) getDb().prepare("UPDATE atm_tasks SET status='failed',error=?,updated_at=? WHERE id=?").run(e instanceof Error ? e.message.slice(0, 2000) : 'Tugas ATM gagal.', Date.now(), id)
    }).finally(() => controllers.delete(id))
  return getAtmTask(id)
}

export async function cancelAtmTask(id: string): Promise<AtmTask> {
  const task = getAtmTask(id)
  if (task.status !== 'running') return task
  controllers.get(id)?.abort()
  getDb().prepare("UPDATE atm_tasks SET status='canceled', message='Dibatalkan; tahap selesai tetap tersimpan.',updated_at=? WHERE id=?").run(Date.now(), id)
  return getAtmTask(id)
}

async function waitJobs(jobs: Job[], signal: AbortSignal, message: (text: string) => void): Promise<void> {
  const deadline = Date.now() + 60 * 60 * 1000
  const abort = () => { for (const job of jobs) void cancelJob(job.id) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      if (Date.now() > deadline) throw new Error('Batas waktu produksi tercapai. Periksa job di editor sebelum melanjutkan.')
      const states = jobs.map((j) => getJob(j.id))
      const bad = states.find((j) => !j || j.status === 'failed' || j.status === 'canceled')
      if (bad !== undefined || states.some((j) => !j)) throw new Error(bad?.error || 'Salah satu proses media berhenti. Periksa di editor lalu lanjutkan tugas baru.')
      const done = states.filter((j) => j?.status === 'done').length
      if (done === jobs.length) return
      message('Memproses media: ' + done + '/' + jobs.length + ' selesai')
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (e) {
    for (const j of jobs) if (getJob(j.id)?.status !== 'done') void cancelJob(j.id)
    throw e
  } finally { signal.removeEventListener('abort', abort) }
}

async function execute(input: AtmTaskInput, signal: AbortSignal, message: (text: string) => void): Promise<unknown> {
  if (input.kind === 'analyze-reference') { message('Gemini membaca audio dan visual video'); return analyzeAtmReference(input.workspaceId, input.referenceId!, signal) }
  if (input.kind === 'analyze-workspace') { message('Menyusun analisis dan versi skill baru'); return analyzeAtmWorkspace(input.workspaceId, signal) }
  const projectId = input.projectId!
  if (input.kind === 'generate-package') return generateAtmPackage(projectId, signal)
  if (input.kind === 'generate-thumbnail') return generateAtmThumbnail(projectId, input.model, signal, input.thumbnailProvider)
  if (!clipsOf(projectId).length) { message('Merancang alur utuh dan menulis naskah'); await generateScript(projectId, signal) }
  signal.throwIfAborted()
  let detail = getAtmProductionDetail(projectId)!
  if (!detail.production.package || detail.summary.packageStale) { message('Menyiapkan judul dan konsep thumbnail'); detail = await generateAtmPackage(projectId, signal) }
  if (input.kind === 'prepare-production') return detail
  message('Menyusun storyboard')
  await generateVisuals(projectId, 'missing', signal)
  signal.throwIfAborted()
  message('Membuat gambar adegan')
  await waitJobs(generateMissingImages(projectId), signal, message)
  signal.throwIfAborted()
  // Reuse completed voices only while their recorded text still matches the scene.
  for (const clip of clipsOf(projectId)) {
    const audio = getAsset(clip.audioAssetId)
    if (audio?.prompt && audio.prompt !== clip.narration) patchClip(clip.id, { audioAssetId: null })
  }
  if (clipsOf(projectId).some((c) => !c.audioAssetId)) {
    message('Membuat narasi dan caption')
    await waitJobs([generateNarration(projectId, 'missing')], signal, message)
  }
  if (getSettings().whisperAuto && clipsOf(projectId).some(c => {
    const audio = getAsset(c.audioAssetId)
    return audio && captionNeedsSync(audio)
  })) {
    message('Menyelaraskan caption dengan suara asli')
    const estimatedCuts = clipsOf(projectId).some(c => getAsset(c.audioAssetId)?.meta.estimatedTimings === true)
    await waitJobs([estimatedCuts ? realignNarration(projectId, 'atm-boundaries:' + input.idempotencyKey) : syncCaptions(projectId, 'stale')], signal, message)
  }
  signal.throwIfAborted()
  if (soundPlanningNeeded(projectId)) {
    message('Menyusun SFX sesuai suasana cerita')
    await waitJobs([startSoundPlan(projectId, 'atm-sound:' + input.idempotencyKey)], signal, message)
  }
  const bundle = getBundle(projectId)
  if (bundle.clips.some((c) => !c.imageAssetId || !c.audioAssetId)) throw new Error('Gambar atau narasi belum lengkap. Lengkapi di editor lalu lanjutkan produksi.')
  if (!inspectCharacterConsistency(projectId).ready) {
    message('Memeriksa dan memperbaiki konsistensi karakter')
    await waitJobs([startCharacterConsistencyReview(projectId, true, 'atm:' + input.idempotencyKey)], signal, message)
  }
  if (!getLatestExportPath(projectId) || !atmExportIsCurrent(projectId)) {
    message('Merender video MP4')
    const renderHash = atmRenderHash(projectId)
    const folder = process.env.BANG_STORY_EXPORT_DIR || join(dataDir(), 'exports')
    await waitJobs([startExport(projectId, { fileName: 'atm-' + projectId.slice(0, 8), folder, resolution: 1080, fps: 30, burnCaptions: true, writeSrt: true, normalizeAudio: bundle.project.editor.normalizeAudio ?? true, duckMusic: bundle.project.editor.duckMusic })], signal, message)
    getDb().prepare('UPDATE atm_productions SET export_hash=? WHERE project_id=?').run(renderHash, projectId)
  }
  signal.throwIfAborted()
  if (!getAtmProductionDetail(projectId)!.thumbnailUrl) {
    message('Membuat thumbnail dengan referensi')
    await generateAtmThumbnail(projectId, input.model, signal, input.thumbnailProvider)
  }
  return getAtmProductionDetail(projectId)
}
