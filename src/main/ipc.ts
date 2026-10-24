import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
let electronApp: any, electronBW: any, electronClip: any, electronDialog: any, electronIpc: any, electronShell: any
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const el = require('electron')
  electronApp = el?.app
  electronBW = el?.BrowserWindow
  electronClip = el?.clipboard
  electronDialog = el?.dialog
  electronIpc = el?.ipcMain
  electronShell = el?.shell
} catch {
  electronApp = null
  electronBW = null
  electronClip = null
  electronDialog = null
  electronIpc = null
  electronShell = null
}
import type {
  ApiProvider,
  AppSettings,
  AspectRatio,
  ExportOptions,
  KeyTestResult,
  LlmProvider,
  ModelSource,
  NewProjectInput,
  ProjectSnapshot,
  SkillInput,
  TtsProvider,
  VoiceOption,
  WordTiming
} from '@shared/types'
import { startExport } from './exporter'
import { generateFlowData } from './flowExport'
import {
  estimateCredits,
  forgetEstimates,
  generateCharacterSheet,
  generateClipImage,
  generateClipTts,
  generateClipVideo,
  generateMissingImages,
  generateMissingVideos,
  generateMissingTts,
  setActiveAsset
} from './generation'
import { cancelJob } from './jobs'
import { generateNarration, syncCaptions } from './narration'
import { cancelDownload, downloadModel, openModelFolder, removeModel, whisperStatus } from './whisper'
import { assetAbsPath } from './paths'
import { detachVoice, splitClip } from './editing'
import { emit } from './events'
import {
  createProject,
  createSkill,
  duplicateProject,
  getAsset,
  getBundle,
  getProject,
  insertAsset,
  listProjects,
  listSkills,
  removeProject,
  removeSkill,
  saveSnapshot,
  patchClip,
  updateAssetMeta,
  updateSkill
} from './repo'
import { clearSecret, keyStatuses, recordCheck, revealSecret, setSecret } from './secrets'
import { dropCache, getSettings, setSettings } from './settings'
import { probeDurationMs, probeSize } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import * as hf from './services/higgsfield'
import * as llm from './services/llm'
import * as ninerouter from './services/ninerouter'
import { generateScript, generateVisuals, generateMusicPrompt } from './story'

type Handler = (...args: any[]) => unknown

export const handlers = new Map<string, Handler>()

function handle(channel: string, fn: Handler): void {
  handlers.set(channel, fn)
  if (electronIpc?.handle) {
    electronIpc.handle(channel, async (_e: any, ...args: any[]) => {
      try {
        return await fn(...args)
      } catch (e) {
        // Only the message crosses the IPC boundary; keep it readable for the user.
        throw new Error((e as Error)?.message ?? String(e))
      }
    })
  }
}

export async function dispatch(channel: string, args: any[] = []): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`Unknown handler: ${channel}`)
  return fn(...args)
}

async function testProvider(provider: ApiProvider, key?: string): Promise<KeyTestResult> {
  if (provider === 'higgsfield') return hf.testCredentials(key)
  if (provider === 'elevenlabs') return eleven.testKey(key)
  if (provider === '9router') return ninerouter.testConnection(undefined, key)
  return llm.testLlm(provider as LlmProvider, key)
}

function defaultExportFolder(): string {
  if (getSettings().exportFolder) return getSettings().exportFolder!
  if (electronApp?.getPath) {
    try {
      return join(electronApp.getPath('videos'), 'Bang Story')
    } catch {}
  }
  return join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'exports')
}

export function registerIpc(): void {
  handle('projects:list', () => listProjects())
  handle('projects:create', (input: NewProjectInput) => getBundle(createProject(input).id))
  handle('projects:get', (id: string) => getBundle(id))
  handle('projects:save', (snap: ProjectSnapshot) => ({ updatedAt: saveSnapshot(snap) }))
  handle('projects:remove', (id: string) => removeProject(id))
  handle('projects:duplicate', (id: string) => duplicateProject(id))

  handle('skills:list', () => listSkills())
  handle('skills:create', (input: SkillInput) => createSkill(input))
  handle('skills:update', (id: string, input: Partial<SkillInput>) => updateSkill(id, input))
  handle('skills:remove', (id: string) => removeSkill(id))

  handle('story:script', (projectId: string) => generateScript(projectId))
  handle('story:musicPrompt', (projectId: string) => generateMusicPrompt(projectId))
  handle('story:visuals', (projectId: string, mode: 'missing' | 'all') => generateVisuals(projectId, mode === 'all' ? 'all' : 'missing'))

  handle('generate:clipImage', (clipId: string) => generateClipImage(clipId))
  handle('generate:clipVideo', (clipId: string) => generateClipVideo(clipId))
  handle('generate:clipTts', (clipId: string) => generateClipTts(clipId))
  handle('generate:characterSheet', (characterId: string) => generateCharacterSheet(characterId))
  handle('generate:missingImages', (projectId: string) => generateMissingImages(projectId))
  handle('generate:missingVideos', (projectId: string) => generateMissingVideos(projectId))
  handle('generate:missingTts', (projectId: string) => generateMissingTts(projectId))
  handle('generate:narration', (projectId: string, mode: 'missing' | 'all') => generateNarration(projectId, mode === 'all' ? 'all' : 'missing'))
  handle('generate:syncCaptions', (projectId: string, mode?: 'stale' | 'all') => syncCaptions(projectId, mode === 'all' ? 'all' : 'stale'))

  handle('whisper:status', () => whisperStatus())
  // The download runs in the background and reports through whisper events.
  handle('whisper:download', () => {
    void downloadModel().catch(() => {})
  })
  handle('whisper:cancel', () => cancelDownload())
  handle('whisper:remove', () => removeModel())
  handle('whisper:openFolder', () => openModelFolder())
  handle('generate:cancel', (jobId: string) => cancelJob(jobId))
  handle('generate:estimate', (kind: 'image' | 'video', modelId: string, aspect: AspectRatio, seconds?: number, resolution?: string | null) =>
    estimateCredits(kind, modelId, aspect, seconds, resolution)
  )

  handle('assets:setActive', (clipId: string, assetId: string) => setActiveAsset(clipId, assetId))
  handle('clips:split', (clipId: string, atMs: number) => splitClip(clipId, Number(atMs)))
  handle('clips:detachVoice', (clipId: string) => detachVoice(clipId))
  // Caption text fixed by hand in the editor; the words keep their times.
  handle('assets:setWords', (assetId: string, words: WordTiming[]) => {
    const a = getAsset(assetId)
    if (!a || a.kind !== 'audio') throw new Error('Suara klip tidak ditemukan')
    const clean = (Array.isArray(words) ? words : [])
      .filter((w) => w && typeof w.text === 'string' && w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }))
    updateAssetMeta(a.id, { ...a.meta, words: clean, editedWords: true })
    const fresh = getAsset(a.id)!
    emit.asset(fresh)
    return fresh
  })
  handle('assets:pickMusic', async (projectId: string) => {
    const win = electronBW?.getFocusedWindow?.()
    if (!electronDialog?.showOpenDialog) return null
    const res = await electronDialog.showOpenDialog(win!, {
      title: 'Pilih musik latar',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    getProject(projectId)
    const src = res.filePaths[0]
    const rel = `music/${randomUUID()}${extname(src).toLowerCase()}`
    const abs = assetAbsPath(projectId, rel)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(src, abs)
    const durationMs = await probeDurationMs(abs).catch(() => null)
    return insertAsset({
      projectId,
      kind: 'music',
      provider: 'local',
      prompt: src.split(/[\\/]/).pop() ?? 'musik',
      localPath: rel,
      durationMs
    })
  })

  handle('assets:pickImage', async (projectId: string) => {
    const win = electronBW?.getFocusedWindow?.()
    if (!electronDialog?.showOpenDialog) return null
    const res = await electronDialog.showOpenDialog(win!, {
      title: 'Pilih gambar logo atau watermark',
      filters: [{ name: 'Gambar', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    getProject(projectId)
    const src = res.filePaths[0]
    const rel = `overlays/${randomUUID()}${extname(src).toLowerCase()}`
    const abs = assetAbsPath(projectId, rel)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(src, abs)
    const size = await probeSize(abs).catch(() => null)
    if (!size) throw new Error('Gambar tidak bisa dibaca. Pakai file PNG, JPG, atau WebP.')
    return insertAsset({
      projectId,
      kind: 'overlay',
      provider: 'local',
      prompt: basename(src),
      localPath: rel,
      width: size.width,
      height: size.height
    })
  })

  handle('assets:pickVideo', async (projectId: string, clipId?: string) => {
    const win = electronBW?.getFocusedWindow?.()
    if (!electronDialog?.showOpenDialog) return null
    const res = await electronDialog.showOpenDialog(win!, {
      title: 'Pilih file video klip',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    getProject(projectId)
    const src = res.filePaths[0]
    const rel = `videos/${randomUUID()}${extname(src).toLowerCase()}`
    const abs = assetAbsPath(projectId, rel)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(src, abs)
    const durationMs = await probeDurationMs(abs).catch(() => null)
    const size = await probeSize(abs).catch(() => null)
    const asset = insertAsset({
      projectId,
      clipId: clipId || null,
      kind: 'video',
      provider: 'local',
      prompt: basename(src),
      localPath: rel,
      durationMs,
      width: size?.width,
      height: size?.height
    })
    if (clipId) {
      patchClip(clipId, { videoAssetId: asset.id, motionType: 'video', mediaInMs: 0 })
      emit.clip({ clipId, patch: { videoAssetId: asset.id, motionType: 'video', mediaInMs: 0 } })
    }
    return asset
  })

  handle('settings:get', () => getSettings())
  handle('settings:set', (patch: Partial<AppSettings>) => setSettings(patch))
  handle('settings:keys', () => keyStatuses())
  handle('settings:setKey', async (provider: ApiProvider, key: string) => {
    const clean = key.trim()
    if (!clean) throw new Error('Kunci masih kosong')
    setSecret(provider, clean)
    dropCache(`models:${provider}`)
    if (provider === 'gemini') dropCache('models:gemini-tts')
    if (provider === 'higgsfield') forgetEstimates()
    const result = await testProvider(provider, clean)
    recordCheck(provider, result.ok, result.message)
    return result
  })
  handle('settings:setCustom', async (baseUrl: string, key: string) => {
    const url = baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Alamat endpoint harus diawali http:// atau https://')
    setSettings({ customBaseUrl: url })
    if (key.trim()) setSecret('custom', key.trim())
    dropCache('models:custom')
    const result = await llm.testLlm('custom', key.trim() || undefined, url)
    recordCheck('custom', result.ok, result.message)
    return result
  })
  handle('settings:setNineRouter', async (baseUrl: string, key: string) => {
    const url = baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Alamat endpoint harus diawali http:// atau https://')
    setSettings({ nineRouterBaseUrl: url })
    if (key.trim()) setSecret('9router', key.trim())
    dropCache('models:9router')
    dropCache('models:9router-tts')
    const result = await ninerouter.testConnection(url, key.trim() || undefined)
    recordCheck('9router', result.ok, result.message)
    return result
  })
  handle('settings:clearKey', (provider: ApiProvider) => {
    clearSecret(provider)
    dropCache(`models:${provider}`)
    if (provider === 'higgsfield') forgetEstimates()
    if (provider === 'custom') setSettings({ customBaseUrl: '' })
    if (provider === '9router') setSettings({ nineRouterBaseUrl: 'http://127.0.0.1:20128/v1' })
  })
  handle('models:list', (source: ModelSource, refresh?: boolean) => llm.listModels(source, !!refresh))
  handle('settings:testKey', async (provider: ApiProvider) => {
    const result = await testProvider(provider).catch((e): KeyTestResult => ({ ok: false, message: (e as Error).message }))
    recordCheck(provider, result.ok, result.message)
    return result
  })
  handle('settings:revealKey', (provider: ApiProvider) => revealSecret(provider))
  handle('settings:voices', async (provider: TtsProvider): Promise<VoiceOption[]> => {
    if (provider === 'gemini') return gemini.listVoices()
    if (provider === '9router') return ninerouter.listVoices()
    return eleven.listVoices()
  })

  handle('export:start', (projectId: string, opts: ExportOptions) => startExport(projectId, opts))
  handle('export:defaultFolder', () => defaultExportFolder())
  handle('export:pickFolder', async () => {
    const win = electronBW?.getFocusedWindow?.()
    if (!electronDialog?.showOpenDialog) return defaultExportFolder()
    const res = await electronDialog.showOpenDialog(win!, {
      title: 'Pilih folder ekspor',
      defaultPath: defaultExportFolder(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    setSettings({ exportFolder: res.filePaths[0] })
    return res.filePaths[0]
  })
  handle('export:reveal', (path: string) => {
    if (electronShell?.showItemInFolder) electronShell.showItemInFolder(path)
  })
  handle('export:flowData', (projectId: string) => generateFlowData(projectId))

  handle('app:version', () => electronApp?.getVersion?.() ?? '1.0.0-web')
  handle('app:copyText', (text: string) => {
    if (electronClip?.writeText) electronClip.writeText(String(text))
  })
  handle('app:openExternal', (url: string) => {
    if (electronShell?.openExternal && /^https:\/\//i.test(url)) return electronShell.openExternal(url)
    return undefined
  })
}
