import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { LANGUAGES, MAX_NINE_ROUTER_IMAGE_CONCURRENCY } from '../shared/models'
import { VISUAL_STYLES } from '../shared/styles'
import type { Clip, Overlay, ProjectBundle, ProjectSnapshot } from '../shared/types'
import { dispatch } from '../main/ipc'
import { generateMusicPrompt, generateScript, generateVisuals } from '../main/story'
import { runJob } from '../main/jobs'
import { eventBus } from '../main/events'
import { dataDir } from '../main/paths'
import { getJob, getJobRaw, getLatestExportPath, getProject, insertIdempotentStoryJob, patchJobPayload } from '../main/repo'
import { getSettings } from '../main/settings'
import { resolveAgentFile } from './agentFiles'
import { registerAtmTools } from './atmTools'
import { registerAgentResources } from './agentResources'
import { assertLatestExportCharacterApproval } from '../main/characterConsistency'
import { realignNarration } from '../main/narration'
import { soundDesignSchema } from '../shared/soundDesign'

const id = z.string().min(1).max(200)
const paidApproval = z.literal(true).describe('Explicit approval for a provider operation that may incur charges.')
const providers = ['higgsfield', 'gemini', 'elevenlabs', 'openrouter', 'groq', 'custom', '9router'] as const
const aspectRatios = ['16:9', '9:16'] as const
const overlayAnchor = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9)])
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const overlayBaseSchema = {
  anchor: overlayAnchor,
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  start: z.number().min(0),
  end: z.number().min(0).nullable()
}
const imageOverlaySchema = z.object({ kind: z.literal('image'), id, assetId: id, ...overlayBaseSchema, width: z.number().min(0.01).max(1), opacity: z.number().min(0).max(1) }).strict()
const textOverlaySchema = z.object({ kind: z.literal('text'), id, text: z.string().max(2000), ...overlayBaseSchema, size: z.number().min(0.01).max(1), color, style: z.enum(['plain', 'outline', 'box']), bold: z.boolean() }).strict()
const overlayCreateSchema = z.discriminatedUnion('kind', [
  imageOverlaySchema.omit({ id: true }),
  textOverlaySchema.omit({ id: true })
])
const overlaySchema = z.discriminatedUnion('kind', [imageOverlaySchema, textOverlaySchema])
const overlayPatchSchema = z.object({
  assetId: id,
  text: z.string().max(2000),
  ...overlayBaseSchema,
  width: z.number().min(0.01).max(1),
  opacity: z.number().min(0).max(1),
  size: z.number().min(0.01).max(1),
  color,
  style: z.enum(['plain', 'outline', 'box']),
  bold: z.boolean()
}).partial().strict().refine((patch) => Object.keys(patch).length > 0, 'Patch must include at least one field')

const projectPatchSchema = z.object({
  title: z.string().min(1).max(200),
  synopsis: z.string().max(20000),
  durationSec: z.number().int().min(1).max(3600),
  sceneCount: z.number().int().min(1).max(500).nullable(),
  sceneSec: z.number().min(1).max(600).nullable(),
  language: z.string().min(1).max(50),
  aspectRatio: z.enum(aspectRatios),
  styleId: z.string().min(1).max(100),
  ttsProvider: z.enum(['gemini', 'elevenlabs', '9router']),
  ttsVoice: z.string().max(200),
  imageProvider: z.enum(['higgsfield', '9router']).nullable(),
  imageModel: z.string().max(200).nullable(),
  videoModel: z.string().max(200).nullable(),
  videoResolution: z.string().max(40).nullable(),
  status: z.enum(['draft', 'script', 'storyboard', 'editing', 'exported']),
  step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
}).partial()

const clipPatchSchema = z.object({
  title: z.string().max(500),
  story: z.string().max(20000),
  visualPrompt: z.string().max(20000),
  visualSource: z.string().max(20000).nullable(),
  narration: z.string().max(20000),
  durationMs: z.number().int().min(1).max(3_600_000),
  characterIds: z.array(id).max(100),
  motionType: z.enum(['camera', 'video']),
  cameraPreset: z.enum(['zoomin', 'zoomout', 'panleft', 'panright', 'kenburns', 'shake', 'static']),
  motionStrength: z.enum(['halus', 'sedang', 'kuat']),
  videoPrompt: z.string().max(20000),
  transition: z.enum(['cut', 'fade', 'slideleft', 'zoomin']),
  videoCamera: z.enum(['zoomin', 'zoomout', 'panleft', 'panright', 'kenburns', 'shake', 'static']),
  videoStrength: z.enum(['halus', 'sedang', 'kuat']),
  transitionMs: z.number().int().min(0).max(60000).nullable(),
  voiceGainDb: z.number().min(-60).max(24),
  mediaInMs: z.number().int().min(0).max(3_600_000),
  voiceInMs: z.number().int().min(0).max(3_600_000),
  voiceOutMs: z.number().int().min(0).max(3_600_000).nullable(),
  voiceStartMs: z.number().int().min(0).max(3_600_000)
}).partial()

const editorPatchSchema = z.object({
  soundDesign: soundDesignSchema,
  normalizeAudio: z.boolean(),
  captionStyle: z.enum(['karaoke', 'tebal', 'minimal', 'subtitle', 'none']),
  captionPosition: z.enum(['atas', 'tengah', 'bawah']),
  captionSize: z.enum(['kecil', 'sedang', 'besar']),
  captionScale: z.number().min(0.5).max(1.8),
  captionFont: z.string().max(100),
  captionColor: color,
  captionHighlight: color,
  captionBg: z.object({ color, opacity: z.number().min(0).max(1) }).nullable(),
  musicAssetId: id.nullable(),
  musicVolumeDb: z.number().min(-60).max(24),
  duckMusic: z.boolean(),
  voiceVolumeDb: z.number().min(-60).max(24),
  musicStartMs: z.number().min(0),
  musicEndMs: z.number().min(0).nullable(),
  musicInMs: z.number().min(0),
  overlays: z.array(overlaySchema).max(100)
}).partial()

const settingsPatchSchema = z.object({
  defaultTtsProvider: z.enum(['gemini', 'elevenlabs', '9router']),
  defaultLanguage: z.string().min(1).max(50),
  llmProvider: z.enum(['gemini', 'openrouter', 'groq', 'custom', '9router']),
  llmModels: z.record(z.string(), z.string().max(200)),
  geminiTtsModel: z.string().max(200),
  elevenModel: z.string().max(200),
  imageModel: z.string().max(200),
  videoModel: z.string().max(200),
  whisperAuto: z.boolean(),
  imageReviewEnabled: z.boolean(),
  nineRouterTtsModel: z.string().max(200),
  nineRouterImageModel: z.string().max(200),
  nineRouterImageConcurrency: z.number().int().min(1).max(MAX_NINE_ROUTER_IMAGE_CONCURRENCY),
  imageProvider: z.enum(['higgsfield', '9router'])
}).partial().strict()

function textResult(value: unknown): { content: { type: 'text'; text: string }[]; structuredContent: { result: unknown } } {
  const result = value ?? null
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return { content: [{ type: 'text', text: text ?? 'null' }], structuredContent: { result } }
}

function publicJob(job: any): any {
  if (!job) return job
  const hiddenPaths = [dataDir(), process.cwd()]
  const safeText = (value: unknown): unknown => typeof value === 'string' ? hiddenPaths.reduce((text, path) => text.split(path).join('[server path]'), value) : value
  let result: unknown
  if (job.kind === 'story' || job.kind === 'sound-plan') {
    try { result = JSON.parse((getJobRaw(job.id) as { payload_json?: string } | undefined)?.payload_json ?? '{}').agentResult } catch {}
  }
  return {
    ...job,
    message: job.kind === 'export' && job.status === 'done' ? 'Export selesai.' : safeText(job.message),
    error: safeText(job.error),
    ...(result !== undefined ? { result } : {})
  }
}

function publicJobResult(value: any): any {
  return Array.isArray(value) ? value.map(publicJob) : publicJob(value)
}

function publicBundle(bundle: ProjectBundle): ProjectBundle {
  return { ...bundle, jobs: bundle.jobs.map(publicJob) }
}

function publicSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const originOnly = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null
    try { return new URL(value).origin } catch { return 'configured endpoint' }
  }
  return {
    ...settings,
    customBaseUrl: originOnly(settings.customBaseUrl),
    nineRouterBaseUrl: originOnly(settings.nineRouterBaseUrl),
    exportFolder: settings.exportFolder ? 'configured on server' : null
  }
}

function publicKeyResult(value: any): { ok: boolean; message: string } {
  return { ok: value?.ok === true, message: value?.ok === true ? 'Provider connected.' : 'Provider check failed; review its configuration.' }
}

async function snapshotFor(projectId: string): Promise<{ bundle: ProjectBundle; snapshot: ProjectSnapshot }> {
  const bundle = (await dispatch('projects:get', [projectId])) as ProjectBundle
  const { createdAt: _createdAt, updatedAt: _updatedAt, coverAssetId: _coverAssetId, ...project } = bundle.project
  return {
    bundle,
    snapshot: {
      project,
      characters: bundle.characters.map(({ sheetAssetId: _sheetAssetId, referenceImageAssetId: _reference, flowId: _flow, ...character }) => character),
      clips: bundle.clips.map(({ imageAssetId: _imageAssetId, videoAssetId: _videoAssetId, audioAssetId: _audioAssetId, importedImageAssetId: _imported, imageFit: _fit, flowId: _flow, ...clip }) => clip)
    }
  }
}

const projectMutationTails = new Map<string, Promise<void>>()

async function withProjectMutation<T>(projectId: string, run: () => T | Promise<T>): Promise<T> {
  const previous = projectMutationTails.get(projectId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => current)
  projectMutationTails.set(projectId, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (projectMutationTails.get(projectId) === tail) projectMutationTails.delete(projectId)
  }
}

function mutateProject<T>(projectId: string, run: (bundle: ProjectBundle, snapshot: ProjectSnapshot) => T | Promise<T>): Promise<T> {
  return withProjectMutation(projectId, async () => {
    const { bundle, snapshot } = await snapshotFor(projectId)
    return run(bundle, snapshot)
  })
}

function validateOverlayReplacement(current: Overlay[], next: Overlay[], confirm?: boolean): void {
  if (new Set(next.map((overlay) => overlay.id)).size !== next.length) throw new Error('Overlay IDs must be unique within a project')
  const nextIds = new Set(next.map((overlay) => overlay.id))
  if (confirm !== true && current.some((overlay) => !nextIds.has(overlay.id))) throw new Error('Set confirm=true to remove existing overlays')
}

async function saveSnapshot(snapshot: ProjectSnapshot, projectId: string): Promise<ProjectBundle> {
  await dispatch('projects:save', [snapshot])
  return publicBundle((await dispatch('projects:get', [projectId])) as ProjectBundle)
}

function paidArgs(args: { approved: true }, values: unknown[]): unknown[] {
  if (args.approved !== true) throw new Error('Set approved=true after reviewing possible provider charges.')
  return values
}

function startStoryJob(projectId: string, operation: 'script' | 'visuals' | 'musicPrompt', idempotencyKey: string, mode?: 'missing' | 'all'): unknown {
  getProject(projectId)
  const { job, created } = insertIdempotentStoryJob(projectId, getSettings().llmProvider, operation, idempotencyKey)
  if (created) {
    runJob(job, 'story', async ({ signal }) => {
      const result = operation === 'script'
        ? await generateScript(projectId, signal)
        : operation === 'visuals'
          ? await generateVisuals(projectId, mode ?? 'missing', signal)
          : await generateMusicPrompt(projectId, signal)
      if (operation === 'musicPrompt') patchJobPayload(job.id, { agentResult: result })
      return { message: operation === 'musicPrompt' ? 'Music prompt generated.' : 'Story generated.' }
    })
  }
  return { jobId: job.id, status: job.status, reused: !created }
}

async function setProviderEndpoint(provider: 'custom' | '9router', baseUrl: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  const settings = await dispatch('settings:get', []) as Record<string, unknown>
  const keyStatuses = await dispatch('settings:keys', []) as { provider: string; configured: boolean }[]
  const urlKey = provider === 'custom' ? 'customBaseUrl' : 'nineRouterBaseUrl'
  const currentUrl = settings[urlKey]
  let currentOrigin = ''
  if (typeof currentUrl === 'string' && currentUrl) {
    try { currentOrigin = new URL(currentUrl).origin } catch {}
  }
  const nextOrigin = new URL(baseUrl).origin
  const hasKey = keyStatuses.some((status) => status.provider === provider && status.configured)
  if (hasKey && currentOrigin !== nextOrigin && !apiKey.trim()) {
    throw new Error('Masukkan API key baru saat mengganti origin provider.')
  }
  return publicKeyResult(await dispatch(provider === 'custom' ? 'settings:setCustom' : 'settings:setNineRouter', [baseUrl, apiKey]))
}

function waitForJob(jobId: string, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      eventBus.off('event:job', listener)
      resolve()
    }
    const listener = (job: any): void => {
      if (job?.id === jobId && ['done', 'failed', 'canceled'].includes(job.status)) finish()
    }
    const timer = setTimeout(finish, waitMs)
    eventBus.on('event:job', listener)
    const current = getJob(jobId)
    if (current && ['done', 'failed', 'canceled'].includes(current.status)) finish()
  })
}

async function uploadFromWorkspace(input: { projectId: string; kind: string; relativePath: string; clipId?: string }, token: string, port: number): Promise<unknown> {
  if ((input.kind === 'image' || input.kind === 'audio') && !input.clipId) throw new Error('clipId is required for kind image or audio.')
  await dispatch('projects:get', [input.projectId])
  let filePath: string
  try { filePath = resolveAgentFile(input.relativePath) } catch { throw new Error('Upload source is missing or outside the agent workspace.') }
  let file: Buffer
  try {
    if (statSync(filePath).size > 32 * 1024 * 1024) throw new Error('Upload exceeds 32 MiB')
    file = readFileSync(filePath)
  } catch (error) {
    if (error instanceof Error && error.message === 'Upload exceeds 32 MiB') throw error
    throw new Error('Upload source is unavailable.')
  }
  const form = new FormData()
  form.append('file', new Blob([file]), basename(filePath))
  const query = new URLSearchParams({ projectId: input.projectId, kind: input.kind })
  if (input.clipId) query.set('clipId', input.clipId)
  const response = await fetch(`http://127.0.0.1:${port}/api/upload?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  const result = (await response.json().catch(() => ({}))) as { asset?: unknown; error?: string }
  if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status})`)
  return result.asset
}

export function registerAgentTools(server: McpServer, options: { token: string; port: number; publicOrigin: string }): void {
  const tool = <Schema extends z.ZodType>(name: string, description: string, schema: Schema, run: (args: z.infer<Schema>) => Promise<unknown> | unknown): void => {
    const callback = async (args: unknown) => {
      try {
        return textResult(await run(args as z.infer<Schema>))
      } catch (error) {
        return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true }
      }
    }
    server.registerTool(name, { description, inputSchema: schema, outputSchema: z.object({ result: z.unknown() }) }, callback as any)
  }

  tool('project.options', 'List supported project languages, visual styles, and aspect ratios.', z.object({}), () => ({
    languages: LANGUAGES.map(({ code, label, english }) => ({ code, label, english })),
    visualStyles: VISUAL_STYLES.map(({ id, name, category, niche }) => ({ id, name, category, niche })),
    aspectRatios
  }))
  tool('project.list', 'List projects and their current status.', z.object({}), () => dispatch('projects:list', []))
  tool('characters.consistency.inspect', 'Read byte-bound character review status for every scene. Changes to artwork, cast, sheets or appearance invalidate approval. No paid call.', z.object({ projectId: id }), ({ projectId }) => dispatch('consistency:inspect', [projectId]))
  tool('visuals.style_reference', 'Pin an owned image as the current project style reference, or null to remove it. Sends actual style image bytes alongside character sheets to generation and review. This invalidates old visual approvals without deleting media. No paid call.', z.object({ projectId: id, assetId: id.nullable() }), ({ projectId, assetId }) => dispatch('consistency:setStyleReference', [projectId, assetId]))
  tool('characters.consistency.review', 'Start one persistent visual review of every scene against actual character sheets. repair=true regenerates failed scenes, with a persistent limit of three image attempts per scene/context across jobs. Stop early on pass; otherwise activate the best inspected candidate and flag best-effort for manual review without blocking export. settings.update imageReviewEnabled=false disables AI review/repair and permits manual export. Poll jobs.get; reuse idempotencyKey after reconnect.', z.object({ projectId: id, repair: z.boolean(), idempotencyKey: z.string().min(1).max(200), approved: paidApproval }), async ({ projectId, repair, idempotencyKey }) => publicJobResult(await dispatch('consistency:review', [projectId, repair, idempotencyKey])))
  tool('project.get', 'Read one project, its scenes, characters, assets, and recent jobs.', z.object({ projectId: id }), async ({ projectId }) => publicBundle((await dispatch('projects:get', [projectId])) as ProjectBundle))
  tool('project.create', 'Create a project from an idea. This only creates a draft; paid generation needs separate approval.', z.object({ synopsis: z.string().max(20000).optional(), durationSec: z.number().int().min(1).max(3600).optional(), sceneCount: z.number().int().min(1).max(500).nullable().optional(), sceneSec: z.number().min(1).max(600).nullable().optional(), language: z.string().max(50).optional(), aspectRatio: z.enum(aspectRatios).optional(), styleId: z.string().max(100).optional(), ttsProvider: z.enum(['gemini', 'elevenlabs', '9router']).optional(), imageProvider: z.enum(['higgsfield', '9router']).optional() }), async (input) => publicBundle((await dispatch('projects:create', [input])) as ProjectBundle))
  tool('project.update', 'Patch project settings, scene text/timing, characters, and editor configuration without replacing asset links. Removing overlays through editor requires confirm=true.', z.object({ projectId: id, project: projectPatchSchema.optional(), clipPatches: z.array(z.object({ clipId: id, patch: clipPatchSchema })).max(500).optional(), characterPatches: z.array(z.object({ characterId: id, patch: z.object({ name: z.string().min(1).max(200), description: z.string().max(10000), sort: z.number().int().min(0).max(10000) }).partial() })).max(200).optional(), editor: editorPatchSchema.optional(), confirm: z.literal(true).optional().describe('Required when editor.overlays removes existing overlays.') }), async ({ projectId, project, clipPatches, characterPatches, editor, confirm }) => mutateProject(projectId, async (bundle, snapshot) => {
    if (project) Object.assign(snapshot.project, project)
    for (const item of clipPatches ?? []) {
      const clip = snapshot.clips.find((value) => value.id === item.clipId)
      if (!clip) throw new Error(`Clip ${item.clipId} is not in project ${projectId}`)
      if (item.patch.characterIds && item.patch.characterIds.some((characterId) => !bundle.characters.some((character) => character.id === characterId))) throw new Error('Every characterIds value must belong to this project')
      Object.assign(clip, item.patch)
    }
    for (const item of characterPatches ?? []) {
      const character = snapshot.characters.find((value) => value.id === item.characterId)
      if (!character) throw new Error(`Character ${item.characterId} is not in project ${projectId}`)
      Object.assign(character, item.patch)
    }
    if (editor) {
      if (editor.musicAssetId && !bundle.assets.some((asset) => asset.id === editor.musicAssetId && asset.kind === 'music')) throw new Error('musicAssetId must reference music in this project')
      if (editor.overlays) validateOverlayReplacement(snapshot.project.editor.overlays ?? [], editor.overlays, confirm)
      for (const overlay of editor.overlays ?? []) if (overlay.kind === 'image' && !bundle.assets.some((asset) => asset.id === overlay.assetId && asset.kind === 'overlay')) throw new Error('Image overlay asset must belong to this project')
      snapshot.project.editor = { ...snapshot.project.editor, ...editor }
    }
    return saveSnapshot(snapshot, projectId)
  }))
  tool('project.duplicate', 'Duplicate project and its existing content.', z.object({ projectId: id }), ({ projectId }) => dispatch('projects:duplicate', [projectId]))
  tool('project.delete', 'Delete a project and its stored media. Requires confirm=true.', z.object({ projectId: id, confirm: z.literal(true) }), async ({ projectId }) => withProjectMutation(projectId, async () => { await dispatch('projects:remove', [projectId]); return { deleted: true, projectId } }))

  tool('story.generate_script', 'Start script generation. Returns a job immediately; reuse idempotencyKey to avoid duplicate provider charges on retry. Get the finished project with project.get.', z.object({ projectId: id, idempotencyKey: z.string().min(1).max(200), approved: paidApproval }), (args) => { paidArgs(args, []); return startStoryJob(args.projectId, 'script', args.idempotencyKey) })
  tool('story.plan_visuals', 'Start visual prompt generation. Returns a job immediately; reuse idempotencyKey to avoid duplicate provider charges on retry.', z.object({ projectId: id, mode: z.enum(['missing', 'all']), idempotencyKey: z.string().min(1).max(200), approved: paidApproval }), (args) => { paidArgs(args, []); return startStoryJob(args.projectId, 'visuals', args.idempotencyKey, args.mode) })
  tool('story.create_music_prompt', 'Start music prompt generation. Returns a job immediately; reuse idempotencyKey to avoid duplicate provider charges on retry. Read its result from jobs.get.', z.object({ projectId: id, idempotencyKey: z.string().min(1).max(200), approved: paidApproval }), (args) => { paidArgs(args, []); return startStoryJob(args.projectId, 'musicPrompt', args.idempotencyKey) })

  tool('character.create', 'Add a character to a project.', z.object({ projectId: id, name: z.string().min(1).max(200), description: z.string().max(10000) }), async ({ projectId, name, description }) => mutateProject(projectId, async (_bundle, snapshot) => {
    snapshot.characters.push({ id: randomUUID(), projectId, name, description, referencePrompt: '', sort: snapshot.characters.length })
    return saveSnapshot(snapshot, projectId)
  }))
  tool('character.update', 'Patch one project-owned character name or appearance description.', z.object({ projectId: id, characterId: id, patch: z.object({ name: z.string().min(1).max(200), description: z.string().max(10000) }).partial().strict().refine((patch) => Object.keys(patch).length > 0, 'Patch must include at least one field') }), async ({ projectId, characterId, patch }) => mutateProject(projectId, async (_bundle, snapshot) => {
    const character = snapshot.characters.find((value) => value.id === characterId)
    if (!character) throw new Error('Character is not in this project')
    Object.assign(character, patch)
    return saveSnapshot(snapshot, projectId)
  }))
  tool('character.delete', 'Remove a character from a project. Requires confirm=true.', z.object({ projectId: id, characterId: id, confirm: z.literal(true) }), async ({ projectId, characterId }) => mutateProject(projectId, async (_bundle, snapshot) => {
    const next = snapshot.characters.filter((character) => character.id !== characterId)
    if (next.length === snapshot.characters.length) throw new Error('Character is not in this project')
    snapshot.characters = next.map((character, sort) => ({ ...character, sort }))
    snapshot.clips = snapshot.clips.map((clip) => ({ ...clip, characterIds: clip.characterIds.filter((value) => value !== characterId) }))
    return saveSnapshot(snapshot, projectId)
  }))
  tool('character.reorder', 'Set exact character order; every current character ID must appear once.', z.object({ projectId: id, characterIds: z.array(id).max(200) }), async ({ projectId, characterIds }) => mutateProject(projectId, async (_bundle, snapshot) => {
    if (new Set(characterIds).size !== characterIds.length || characterIds.length !== snapshot.characters.length || characterIds.some((characterId) => !snapshot.characters.some((character) => character.id === characterId))) throw new Error('characterIds must contain every project character exactly once')
    snapshot.characters = characterIds.map((characterId, sort) => ({ ...snapshot.characters.find((character) => character.id === characterId)!, sort }))
    return saveSnapshot(snapshot, projectId)
  }))
  tool('clip.reorder', 'Set exact scene order; every current clip ID must appear once.', z.object({ projectId: id, clipIds: z.array(id).max(500) }), async ({ projectId, clipIds }) => mutateProject(projectId, async (_bundle, snapshot) => {
    if (new Set(clipIds).size !== clipIds.length || clipIds.length !== snapshot.clips.length || clipIds.some((clipId) => !snapshot.clips.some((clip) => clip.id === clipId))) throw new Error('clipIds must contain every project clip exactly once')
    snapshot.clips = clipIds.map((clipId, sort) => ({ ...snapshot.clips.find((clip) => clip.id === clipId)!, sort }))
    return saveSnapshot(snapshot, projectId)
  }))
  tool('clip.create', 'Append a scene or insert it after an existing scene; optional fields override scene defaults.', z.object({ projectId: id, afterClipId: id.nullable().optional(), patch: clipPatchSchema.optional() }), async ({ projectId, afterClipId, patch }) => mutateProject(projectId, async (bundle, snapshot) => {
    const at = afterClipId ? snapshot.clips.findIndex((clip) => clip.id === afterClipId) + 1 : snapshot.clips.length
    if (afterClipId && at === 0) throw new Error('afterClipId is not in this project')
    if (patch?.characterIds && patch.characterIds.some((characterId) => !bundle.characters.some((character) => character.id === characterId))) throw new Error('Every characterIds value must belong to this project')
    const clip: Clip = {
      id: randomUUID(), projectId, sort: at, title: 'Adegan baru', story: '', visualPrompt: '', visualSource: null, narration: '', durationMs: 5000, characterIds: [],
      motionType: 'camera', cameraPreset: 'zoomin', motionStrength: 'halus', videoPrompt: '', transition: 'fade', videoCamera: 'static', videoStrength: 'halus', transitionMs: null,
      voiceGainDb: 0, mediaInMs: 0, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0, importedImageAssetId: null, imageFit: 'cover', imageAssetId: null, videoAssetId: null, audioAssetId: null
    }
    Object.assign(clip, patch)
    const { imageAssetId: _image, videoAssetId: _video, audioAssetId: _audio, importedImageAssetId: _imported, imageFit: _fit, flowId: _flow, ...snapshotClip } = clip
    snapshot.clips.splice(at, 0, snapshotClip)
    snapshot.clips = snapshot.clips.map((value, sort) => ({ ...value, sort }))
    return saveSnapshot(snapshot, projectId)
  }))
  tool('clip.delete', 'Delete a scene and its scene row. Requires confirm=true.', z.object({ projectId: id, clipId: id, confirm: z.literal(true) }), async ({ projectId, clipId }) => mutateProject(projectId, async (_bundle, snapshot) => {
    const next = snapshot.clips.filter((clip) => clip.id !== clipId)
    if (next.length === snapshot.clips.length) throw new Error('Clip is not in this project')
    snapshot.clips = next.map((clip, sort) => ({ ...clip, sort }))
    await saveSnapshot(snapshot, projectId)
    return { deleted: true, projectId, clipId }
  }))
  tool('clip.update', 'Patch scene text, duration, assigned characters, motion, transition, or voice timing.', z.object({ projectId: id, clipId: id, patch: clipPatchSchema }), async ({ projectId, clipId, patch }) => mutateProject(projectId, async (bundle, snapshot) => {
    const clip = snapshot.clips.find((value) => value.id === clipId)
    if (!clip) throw new Error('Clip is not in this project')
    if (patch.characterIds && patch.characterIds.some((characterId) => !bundle.characters.some((character) => character.id === characterId))) throw new Error('Every characterIds value must belong to this project')
    Object.assign(clip, patch)
    return saveSnapshot(snapshot, projectId)
  }))
  tool('clip.split', 'Split one scene at a millisecond position.', z.object({ clipId: id, atMs: z.number().int().min(1).max(3_600_000) }), async ({ clipId, atMs }) => publicBundle((await dispatch('clips:split', [clipId, atMs])) as ProjectBundle))
  tool('clip.detach_voice', 'Remove the voice asset from a scene.', z.object({ clipId: id }), async ({ clipId }) => { await dispatch('clips:detachVoice', [clipId]); return { detached: true, clipId } })
  tool('sound.asset_info', 'Record the source and usage license of a project-owned SFX asset.', z.object({ projectId: id, assetId: id, source: z.string().min(1).max(1000), license: z.string().min(1).max(1000) }), async ({ projectId, assetId, source, license }) => dispatch('sound:assetInfo', [projectId, assetId, source, license]))
  tool('sound.plan', 'Plan scene-aware SFX with the configured writer. Returns a persistent job; preserve idempotencyKey after reconnect. Manual cues are retained.', z.object({ projectId: id, idempotencyKey: id, approved: paidApproval }), async ({ projectId, idempotencyKey }) => publicJob(await dispatch('sound:plan', [projectId, idempotencyKey])))
  tool('audio.prepare', 'Prepare a cached local mix for preview and export. Does not call TTS or a paid sound provider. Poll jobs.get for resultAssetId.', z.object({ projectId: id, idempotencyKey: id }), async ({ projectId, idempotencyKey }) => publicJob(await dispatch('audio:prepare', [projectId, idempotencyKey])))
  tool('editor.update', 'Patch SFX cues, captions, music timing and volume, narration volume, or overlays. Removing existing overlays requires confirm=true.', z.object({ projectId: id, editor: editorPatchSchema, confirm: z.literal(true).optional().describe('Required when editor.overlays removes existing overlays.') }), async ({ projectId, editor, confirm }) => mutateProject(projectId, async (bundle, snapshot) => {
    if (editor.musicAssetId && !bundle.assets.some((asset) => asset.id === editor.musicAssetId && asset.kind === 'music')) throw new Error('musicAssetId must reference music in this project')
    if (editor.overlays) validateOverlayReplacement(snapshot.project.editor.overlays ?? [], editor.overlays, confirm)
    for (const overlay of editor.overlays ?? []) if (overlay.kind === 'image' && !bundle.assets.some((asset) => asset.id === overlay.assetId && asset.kind === 'overlay')) throw new Error('Image overlay asset must belong to this project')
    snapshot.project.editor = { ...snapshot.project.editor, ...editor }
    return saveSnapshot(snapshot, projectId)
  }))
  tool('overlay.create', 'Add a text or image overlay to a project. Image assets must belong to that project.', z.object({ projectId: id, overlay: overlayCreateSchema }), async ({ projectId, overlay }) => mutateProject(projectId, async (bundle, snapshot) => {
    const overlays = snapshot.project.editor.overlays ?? []
    if (overlays.length >= 100) throw new Error('Project already has the maximum of 100 overlays')
    if (overlay.kind === 'image' && !bundle.assets.some((asset) => asset.id === overlay.assetId && asset.kind === 'overlay')) throw new Error('Image overlay asset must belong to this project')
    const created = { ...overlay, id: randomUUID() } as Overlay
    snapshot.project.editor = { ...snapshot.project.editor, overlays: [...overlays, created] }
    const result = await saveSnapshot(snapshot, projectId)
    return { overlay: created, project: result }
  }))
  tool('overlay.update', 'Patch one project-owned overlay. Image assets must belong to that project.', z.object({ projectId: id, overlayId: id, patch: overlayPatchSchema }), async ({ projectId, overlayId, patch }) => mutateProject(projectId, async (bundle, snapshot) => {
    const overlays = snapshot.project.editor.overlays ?? []
    const index = overlays.findIndex((overlay) => overlay.id === overlayId)
    if (index < 0) throw new Error('Overlay is not in this project')
    const updated = overlaySchema.parse({ ...overlays[index], ...patch, id: overlayId }) as Overlay
    if (updated.kind === 'image' && !bundle.assets.some((asset) => asset.id === updated.assetId && asset.kind === 'overlay')) throw new Error('Image overlay asset must belong to this project')
    overlays[index] = updated
    snapshot.project.editor = { ...snapshot.project.editor, overlays }
    return saveSnapshot(snapshot, projectId)
  }))
  tool('overlay.delete', 'Delete one project-owned overlay. Requires confirm=true.', z.object({ projectId: id, overlayId: id, confirm: z.literal(true) }), async ({ projectId, overlayId }) => mutateProject(projectId, async (_bundle, snapshot) => {
    const overlays = snapshot.project.editor.overlays ?? []
    const next = overlays.filter((overlay) => overlay.id !== overlayId)
    if (next.length === overlays.length) throw new Error('Overlay is not in this project')
    snapshot.project.editor = { ...snapshot.project.editor, overlays: next }
    await saveSnapshot(snapshot, projectId)
    return { deleted: true, projectId, overlayId }
  }))

  tool('media.generate_image', 'Generate one scene image. May incur provider charges; estimate first and pass explicit approval.', z.object({ clipId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:clipImage', paidArgs(args, [args.clipId]))))
  tool('media.generate_video', 'Generate one scene video. May incur provider charges; estimate first and pass explicit approval.', z.object({ clipId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:clipVideo', paidArgs(args, [args.clipId]))))
  tool('media.generate_voice', 'Generate one scene voice. May incur provider charges; pass explicit approval.', z.object({ clipId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:clipTts', paidArgs(args, [args.clipId]))))
  tool('media.generate_character_sheet', 'Generate a character reference sheet. May incur provider charges; pass explicit approval.', z.object({ characterId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:characterSheet', paidArgs(args, [args.characterId]))))
  tool('media.generate_missing_images', 'Generate missing scene images. May incur provider charges; estimate first and pass explicit approval.', z.object({ projectId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:missingImages', paidArgs(args, [args.projectId]))))
  tool('media.generate_missing_videos', 'Generate missing scene videos. May incur provider charges; estimate first and pass explicit approval.', z.object({ projectId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:missingVideos', paidArgs(args, [args.projectId]))))
  tool('media.generate_missing_voice', 'Generate missing scene voice. May incur provider charges; pass explicit approval.', z.object({ projectId: id, approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:missingTts', paidArgs(args, [args.projectId]))))
  tool('media.generate_narration', 'Generate narration across several scenes. May incur provider charges; pass explicit approval.', z.object({ projectId: id, mode: z.enum(['missing', 'all']), approved: paidApproval }), async (args) => publicJobResult(await dispatch('generate:narration', paidArgs(args, [args.projectId, args.mode]))))
  tool('captions.sync', 'Align captions to existing narration with local Whisper. This does not call a paid provider.', z.object({ projectId: id, mode: z.enum(['stale', 'all']).optional() }), async ({ projectId, mode }) => publicJobResult(await dispatch('generate:syncCaptions', [projectId, mode])))
  tool('narration.realign', 'Reassemble existing untrimmed narration, align all spoken words locally, then recut scene boundaries. Preserves original assets and makes no TTS request. Reuse the same key after reconnecting.', z.object({ projectId: id, idempotencyKey: id }), async ({ projectId, idempotencyKey }) => publicJobResult(realignNarration(projectId, idempotencyKey)))
  tool('generation.estimate', 'Estimate provider credits and USD for one image or video request.', z.object({ kind: z.enum(['image', 'video']), modelId: z.string().min(1).max(200), aspect: z.enum(aspectRatios), seconds: z.number().min(1).max(60).optional(), resolution: z.string().max(40).nullable().optional() }), ({ kind, modelId, aspect, seconds, resolution }) => dispatch('generate:estimate', [kind, modelId, aspect, seconds, resolution]))
  tool('asset.activate', 'Set a project-owned image, video, or voice asset as active for one scene.', z.object({ clipId: id, assetId: id }), async ({ clipId, assetId }) => { await dispatch('assets:setActive', [clipId, assetId]); return { activated: true, clipId, assetId } })
  tool('asset.set_caption_words', 'Replace caption words for an audio asset while preserving supplied start and end timings.', z.object({ assetId: id, words: z.array(z.object({ text: z.string().min(1).max(1000), start: z.number().min(0), end: z.number().min(0) })).max(10000) }), ({ assetId, words }) => dispatch('assets:setWords', [assetId, words]))
  tool('asset.upload', 'Upload a file from the configured agent workspace. relativePath cannot leave that directory. clipId is required for image and audio uploads.', z.object({ projectId: id, kind: z.enum(['music', 'sfx', 'video', 'overlay', 'image', 'audio']), relativePath: z.string().min(1).max(1000), clipId: id.optional().describe('Required for kind image or audio; attaches the file to this scene.') }), (args) => uploadFromWorkspace(args, options.token, options.port))

  tool('settings.get', 'Read non-secret settings. Server filesystem paths are omitted.', z.object({}), async () => {
    const settings = await dispatch('settings:get', []) as Record<string, unknown>
    return publicSettings(settings)
  })
  tool('settings.update', 'Update non-secret app defaults. Export paths cannot be set through MCP.', z.object({ patch: settingsPatchSchema }), async ({ patch }) => {
    const settings = await dispatch('settings:set', [patch]) as Record<string, unknown>
    return publicSettings(settings)
  })
  tool('settings.key_status', 'Read provider key status and masked previews; raw keys are never returned.', z.object({}), async () => {
    const statuses = await dispatch('settings:keys', []) as any[]
    return statuses.map(({ provider, configured, lastOk, checkedAt, preview, unreadable }) => ({ provider, configured, lastOk, checkedAt, preview, unreadable }))
  })
  tool('settings.set_key', 'Store and test one provider API key. Key is write-only and not returned.', z.object({ provider: z.enum(providers), key: z.string().min(1).max(10000) }), async ({ provider, key }) => publicKeyResult(await dispatch('settings:setKey', [provider, key])))
  tool('settings.set_custom_endpoint', 'Set an OpenAI-compatible base URL and optional API key. A new API key is required when changing origin if one is already stored.', z.object({ baseUrl: z.string().url().max(2000), apiKey: z.string().max(10000).optional().default('') }), ({ baseUrl, apiKey }) => setProviderEndpoint('custom', baseUrl, apiKey))
  tool('settings.set_ninerouter', 'Set the 9Router base URL and optional API key. A new API key is required when changing origin if one is already stored.', z.object({ baseUrl: z.string().url().max(2000), apiKey: z.string().max(10000).optional().default('') }), ({ baseUrl, apiKey }) => setProviderEndpoint('9router', baseUrl, apiKey))
  tool('settings.clear_key', 'Clear one stored provider credential. Requires confirm=true.', z.object({ provider: z.enum(providers), confirm: z.literal(true) }), async ({ provider }) => { await dispatch('settings:clearKey', [provider]); return { cleared: true, provider } })
  tool('settings.test_key', 'Test connectivity for a configured provider key.', z.object({ provider: z.enum(providers) }), async ({ provider }) => publicKeyResult(await dispatch('settings:testKey', [provider])))
  tool('settings.list_voices', 'List available voice choices for a TTS provider.', z.object({ provider: z.enum(['gemini', 'elevenlabs', '9router']) }), ({ provider }) => dispatch('settings:voices', [provider]))
  tool('models.list', 'List current models for a provider; refresh is optional.', z.object({ source: z.enum(['gemini', 'openrouter', 'groq', 'custom', '9router', 'gemini-tts', 'elevenlabs', '9router-tts', '9router-image']), refresh: z.boolean().optional().default(false) }), ({ source, refresh }) => dispatch('models:list', [source, refresh]))

  tool('jobs.get', 'Read one job without exposing server paths.', z.object({ jobId: id }), ({ jobId }) => publicJob(getJob(jobId)))
  tool('jobs.wait', 'Wait up to 30 seconds for a job to finish, then return its latest state. Never restarts work.', z.object({ jobId: id, waitMs: z.number().int().min(0).max(30000).optional().default(10000) }), async ({ jobId, waitMs }) => { if (!getJob(jobId)) throw new Error('Job not found'); await waitForJob(jobId, waitMs); return publicJob(getJob(jobId)) })
  tool('jobs.cancel', 'Cancel a queued or running job.', z.object({ jobId: id }), async ({ jobId }) => { await dispatch('generate:cancel', [jobId]); return publicJob(getJob(jobId)) })
  tool('events.wait', 'Wait for one app event on selected channels for up to 30 seconds.', z.object({ channels: z.array(z.enum(['job', 'clip', 'character', 'asset', 'whisper'])).min(1).max(5).optional().default(['job']), waitMs: z.number().int().min(0).max(30000).optional().default(10000) }), ({ channels, waitMs }) => new Promise((resolve) => {
    const eventNames = [...new Set(channels)].map((channel) => `event:${channel}`)
    const listeners = new Map<string, (payload: unknown) => void>()
    const finish = (result: unknown): void => {
      clearTimeout(timer)
      for (const [name, listener] of listeners) eventBus.off(name, listener)
      resolve(result)
    }
    for (const name of eventNames) {
      const listener = (payload: unknown): void => finish({ channel: name.slice(6), payload: name === 'event:job' ? publicJob(payload) : payload })
      listeners.set(name, listener)
      eventBus.on(name, listener)
    }
    const timer = setTimeout(() => finish({ timeout: true }), waitMs)
  }))

  tool('whisper.status', 'Read local Whisper model availability and download progress.', z.object({}), () => dispatch('whisper:status', []))
  tool('whisper.download', 'Start downloading the local Whisper model. Download reports progress through events.', z.object({}), async () => { await dispatch('whisper:download', []); return { started: true } })
  tool('whisper.cancel', 'Cancel local Whisper model download.', z.object({}), async () => { await dispatch('whisper:cancel', []); return { canceled: true } })
  tool('whisper.remove', 'Remove the local Whisper model. Requires confirm=true.', z.object({ confirm: z.literal(true) }), async () => { await dispatch('whisper:remove', []); return { removed: true } })

  tool('export.start', 'Render a project into the configured server export directory.', z.object({ projectId: id, fileName: z.string().min(1).max(200), resolution: z.union([z.literal(720), z.literal(1080), z.literal(2160)]), fps: z.union([z.literal(30), z.literal(60)]), burnCaptions: z.boolean(), writeSrt: z.boolean(), normalizeAudio: z.boolean(), duckMusic: z.boolean() }), async ({ projectId, ...settings }) => publicJobResult(await dispatch('export:start', [projectId, { ...settings, folder: process.env.BANG_STORY_EXPORT_DIR || join(dataDir(), 'exports') }])))
  tool('export.default_destination', 'Report whether server export destination is configured without revealing its filesystem path.', z.object({}), () => ({ destination: process.env.BANG_STORY_EXPORT_DIR ? 'configured' : 'app data exports' }))
  tool('export.flow_data', 'Get Google Flow media and prompt data for one project.', z.object({ projectId: id }), ({ projectId }) => dispatch('export:flowData', [projectId]))
  tool('export.download', 'Get the authenticated URL for the latest completed MP4 of a project.', z.object({ projectId: id }), ({ projectId }) => {
    assertLatestExportCharacterApproval(projectId)
    if (!getLatestExportPath(projectId)) throw new Error('No completed export for this project')
    return { projectId, url: `${options.publicOrigin}/api/download-project?projectId=${encodeURIComponent(projectId)}`, authorization: 'Send the MCP bearer token in the Authorization header.', fileName: basename(getLatestExportPath(projectId)!) }
  })
  tool('app.info', 'Read app version and supported top-level capabilities.', z.object({}), async () => ({ version: await dispatch('app:version', []), capabilities: ['projects', 'story', 'storyboard', 'media', 'captions', 'timeline', 'sfx', 'audio-mix', 'settings', 'jobs', 'export'] }))

  registerAtmTools(server)
  registerAgentResources(server)
}
