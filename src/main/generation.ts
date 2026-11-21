import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { estimateWordTimings } from '@shared/captions'
import { stripVoiceTags } from '@shared/speech'
import { getImageModel, getVideoModel, imageBody, maxRefs, promptLimit, videoBody, type HfModel } from '@shared/higgsfield'
import { DEFAULT_NINE_ROUTER_IMAGE_MODEL, supportsNineRouterImageReferences, isFluxImageModel } from '@shared/models'
import { sceneImageId } from '@shared/flowV2'
import { getSceneStylePrompt, getStyle } from '@shared/styles'
import type { AspectRatio, Asset, Character, Clip, CreditEstimate, Job, Project, WordTiming } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { assetAbsPath } from './paths'
import {
  activeJobFor,
  charactersOf,
  clipsOf,
  getAsset,
  getCharacter,
  getClip,
  getJob,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  setCharacterSheet,
  touchProject,
  unfinishedJobs,
  updateAssetMeta,
  updateJob
} from './repo'
import { dropCache, getSettings, readCache, writeCache } from './settings'
import { probeDurationMs, probeSize } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import * as hf from './services/higgsfield'
import * as ninerouter from './services/ninerouter'
import { downloadTo, sleep } from './services/http'
import { adoptLegacySceneCandidates, bestSceneCandidate, characterReferences, imageData, markBestEffort, requiresReview, reviewCharacterCandidate, sceneCharacters, sceneImageBudgetKey, styleReference } from './characterConsistency'
import { cachedReferenceUrl } from './referenceCache'

const DAY = 24 * 60 * 60 * 1000

class CharacterMismatch extends Error {
  constructor(public correction: string) { super('Karakter belum sesuai referensi: ' + correction) }
}

function activateSceneImage(clipId: string, assetId: string, previousAssetId: string | null): string {
  const clip = getClip(clipId)
  if (clip.imageAssetId !== previousAssetId) throw new Error('Gambar aktif diubah saat generasi berjalan. Kandidat disimpan tanpa menimpa pilihan terbaru.')
  patchClip(clipId, { imageAssetId: assetId })
  emit.clip({ clipId, patch: { imageAssetId: assetId } })
  const project = getProject(clip.projectId)
  if (!project.coverAssetId || clipsOf(project.id)[0]?.id === clipId) touchProject(project.id, { coverAssetId: assetId })
  return assetId
}

function selectBudgetCandidate(clipId: string, budgetKey: string, previousAssetId: string | null): string {
  if (sceneImageBudgetKey(clipId) !== budgetKey) throw new Error('Adegan atau referensi berubah. Kandidat lama tetap disimpan.')
  const best = bestSceneCandidate(clipId, budgetKey)
  if (!best) throw new Error('Batas tiga percobaan gambar tercapai. Belum ada kandidat dengan pemeriksaan valid; tinjau manual di Pengaturan > Umum.')
  activateSceneImage(clipId, best, previousAssetId)
  markBestEffort(clipId, best)
  return best
}

function reserveImageAttempt(key: string, clipId: string): boolean {
  const cached = readCache<number>(key)
  const count = cached?.value ?? adoptLegacySceneCandidates(clipId, key)
  if (!cached) writeCache(key, count)
  if (count >= 3) return false
  // Reserve before sending: a timeout/restart must not silently replenish paid attempts.
  writeCache(key, count + 1)
  return true
}

function extFromType(contentType: string, url: string, fallback: string): string {
  if (/png/.test(contentType)) return '.png'
  if (/jpe?g/.test(contentType)) return '.jpg'
  if (/webp/.test(contentType)) return '.webp'
  if (/mp4/.test(contentType)) return '.mp4'
  const m = /\.(png|jpe?g|webp|mp4|mov)(\?|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : fallback
}

function saveFile(projectId: string, folder: string, ext: string, bytes: Buffer): string {
  const rel = `${folder}/${randomUUID()}${ext}`
  const abs = assetAbsPath(projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return rel
}

/** A URL Higgsfield can fetch for a stored asset: its own recent result URL, or a fresh upload. */
async function publicUrlFor(asset: Asset, signal: AbortSignal): Promise<string> {
  const fileHash = createHash('sha256').update(readFileSync(assetAbsPath(asset.projectId, asset.localPath))).digest('hex')
  const cached = cachedReferenceUrl(asset, fileHash, Date.now())
  if (cached) return cached
  const url = await hf.uploadFile(assetAbsPath(asset.projectId, asset.localPath), signal)
  const current = getAsset(asset.id)
  if (!current) throw new Error('Aset referensi dihapus saat unggahan berjalan.')
  updateAssetMeta(asset.id, { ...current.meta, uploadedUrl: url, uploadedAt: Date.now(), uploadedHash: fileHash })
  return url
}

function imageProgress(ctx: TaskCtx, what: string) {
  return (status: hf.HfStatus, elapsed: number): void => {
    if (status === 'queued') ctx.progress(0.12, 'Mengantre di Higgsfield')
    else ctx.progress(0.15 + 0.75 * (1 - Math.exp(-elapsed / 45_000)), what)
  }
}

// ---------- prompts ----------

function characterLine(c: Character): string {
  return `${c.name}: ${c.description}`
}

/** Splits the storyboard's "Avoid:" line off the scene, so it can be phrased as a clear instruction. */
function splitAvoid(visual: string): { scene: string; avoid: string } {
  const lines = visual.split('\n')
  const i = lines.findIndex((l) => /^\s*avoid\s*:/i.test(l))
  if (i < 0) return { scene: visual.trim(), avoid: '' }
  const avoid = lines[i].replace(/^\s*avoid\s*:\s*/i, '').replace(/\.$/, '').trim()
  lines.splice(i, 1)
  return { scene: lines.join('\n').trim(), avoid }
}

/**
 * Art style applies to the whole scene; selected reference pixels take precedence over a broad preset.
 * Clothing follows the scene's Wardrobe line when it has one, so a
 * character can change out of the outfit on their reference sheet (no spacesuit indoors).
 */
function clipPrompt(project: Project, clip: Clip, chars: Character[], refNames: string[], limit: number, styleImageIndex?: number, firstReferenceIndex = 1): string {
  const style = getStyle(project.styleId)
  const { scene, avoid } = splitAvoid(clip.visualPrompt)
  const wardrobe = /^\s*wardrobe\s*:/im.test(scene)
  const parts = [`Required art style for the ENTIRE frame:\n${getSceneStylePrompt(project.styleId, !!styleImageIndex)}`, `Scene:\n${scene}`]
  if (chars.length)
    parts.push(
      `Recurring characters in this scene. Keep each one's body, face, hair and skin exactly as described${refNames.length ? ' and as on their reference sheet' : ''}.` +
        (wardrobe
          ? ' Their clothing follows the Wardrobe line of the scene: the default outfit only where it says so, otherwise the custom outfit.'
          : ' They wear their default outfit.') +
        `\n${chars.filter(c => !refNames.includes(c.name)).map(characterLine).join('\n')}`
    )
  if (refNames.length)
    parts.unshift(
      `CHARACTER REFERENCES — authoritative identities:\n${refNames.map((name, i) => `IMAGE ${i + firstReferenceIndex} = ${name}.`).join('\n')}\nEach sheet shows multiple views of ONE person. Render each named character once. Never transfer a face, age, hair, accessories or outfit between characters. Preserve each sheet's identity, proportions and colors. ` +
        (wardrobe ? 'Copy the costume from a sheet only for characters whose Wardrobe line says "default outfit". ' : 'Match the costume to the sheet. ') +
        'Do not copy the sheet layout, poses or plain background.'
    )
  parts.push(chars.length
    ? 'Only these recurring foreground characters may appear: ' + chars.map(c => c.name).join(', ') + '. No substitute protagonist, invented headwear or changed hair/glasses. Match the actual reference sheets exactly.'
    : 'Environment/detail shot only. Render the setting and objects described in Action. Do not invent people, faces, creatures, figures or silhouettes anywhere; any explicitly requested supporting extras must match Action exactly.')
  if (styleImageIndex) parts.push(`STYLE REFERENCE IMAGE ${styleImageIndex + firstReferenceIndex - 1}: match ONLY its flatness, palette, linework, simple shading and background treatment. It is NOT another character sheet. Do not copy its scene, characters or layout. All characters still follow their own supplied identity sheets. The new scene and all backgrounds must use the same illustration technique as this style image.`)
  if (avoid) parts.push(`Must not appear in the image: ${avoid}.`)
  parts.push(`Frame format ${project.aspectRatio}, full-bleed composition.`)
  const full = parts.join('\n\n')
  if (full.length <= limit) return full
  if (styleImageIndex) throw new Error('Batas prompt model tidak cukup untuk menjaga referensi karakter dan gaya. Pilih model dengan batas prompt lebih besar.')
  // Models with short prompt limits get the scene first, so trimming only loses style detail.
  return [scene, chars.map(characterLine).join('; '), avoid && `Must not appear: ${avoid}.`, style.prompt].filter(Boolean).join('\n\n')
}

function sheetPrompt(project: Project, c: Character): string {
  const style = getStyle(project.styleId)
  return [
    style.prompt,
    `Character reference sheet for "${c.name}": ${c.description}. The character is ${style.characterHint}.`,
    'Show the SAME character three times side by side: front view, three-quarter view and side view, full body, neutral standing pose, evenly spaced, on a plain light neutral background (this overrides any background instruction above). Consistent proportions, costume and colors in all three views.'
  ].join('\n\n')
}

// ---------- waiting for character sheets ----------

async function waitForSheets(characterIds: string[], signal: AbortSignal): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    const pending = characterIds.some((id) => activeJobFor({ characterId: id }, 'sheet'))
    if (!pending) return
    await sleep(2000, signal)
  }
}

async function referenceUrls(model: HfModel, chars: Character[], signal: AbortSignal): Promise<{ urls: string[]; names: string[] }> {
  const limit = maxRefs(model)
  if (chars.length > limit) throw new Error('Model gambar ini tidak dapat menerima seluruh referensi karakter. Pilih model yang mendukung cukup gambar referensi.')
  await waitForSheets(
    chars.map((c) => c.id),
    signal
  )
  const urls: string[] = []
  const names: string[] = []
  for (const c of chars) {
    const fresh = getCharacter(c.id)
    const sheet = getAsset(fresh.referenceImageAssetId ?? fresh.sheetAssetId)
    if (!sheet) throw new Error('Referensi karakter ' + fresh.name + ' belum tersedia; referensi tidak akan dilewati.')
    urls.push(await publicUrlFor(sheet, signal))
    names.push(fresh.name)
  }
  return { urls, names }
}

// ---------- finishing a Higgsfield request (also used to resume after a restart) ----------

interface HfPayload {
  target: 'clip-image' | 'sheet' | 'clip-video'
  model: string
  prompt: string
  previousImageAssetId?: string | null
  imageBudgetKey?: string
}

async function finishHiggsfield(ctx: TaskCtx, job: Job, requestId: string, payload: HfPayload): Promise<string> {
  const isVideo = payload.target === 'clip-video'
  const result = await hf.waitForResult(
    requestId,
    imageProgress(ctx, isVideo ? 'Membuat video' : payload.target === 'sheet' ? 'Membuat lembar karakter' : 'Membuat gambar'),
    ctx.signal,
    isVideo ? 30 * 60 * 1000 : 15 * 60 * 1000
  )
  const url = isVideo ? result.video?.url : result.images?.[0]?.url
  if (!url) throw new Error('Higgsfield selesai tanpa file hasil')
  ctx.progress(0.93, 'Mengunduh hasil')
  const { bytes, contentType } = await downloadTo(url, ctx.signal)
  const rel = saveFile(job.projectId, isVideo ? 'videos' : 'images', extFromType(contentType, url, isVideo ? '.mp4' : '.png'), bytes)
  const abs = assetAbsPath(job.projectId, rel)
  const size = await probeSize(abs)
  const durationMs = isVideo ? await probeDurationMs(abs).catch(() => null) : null
  const asset = insertAsset({
    projectId: job.projectId,
    clipId: job.clipId,
    characterId: job.characterId,
    kind: isVideo ? 'video' : 'image',
    provider: 'higgsfield',
    model: payload.model,
    prompt: payload.prompt,
    remoteId: requestId,
    remoteUrl: url,
    localPath: rel,
    durationMs,
    width: size?.width ?? null,
    height: size?.height ?? null,
    meta: payload.imageBudgetKey ? { imageBudgetKey: payload.imageBudgetKey } : {}
  })
  emit.asset(asset)
  if (payload.target === 'sheet' && job.characterId) {
    setCharacterSheet(job.characterId, asset.id)
    emit.character({ characterId: job.characterId, patch: { sheetAssetId: asset.id } })
  } else if (payload.target === 'clip-image' && job.clipId) {
    ctx.progress(0.96, 'Memeriksa karakter terhadap gambar referensi')
    const review = await reviewCharacterCandidate(job.clipId, asset.id, ctx.signal)
    if (review.verdict !== 'pass') {
      if (payload.imageBudgetKey && (readCache<number>(payload.imageBudgetKey)?.value ?? 0) >= 3) return selectBudgetCandidate(job.clipId, payload.imageBudgetKey, payload.previousImageAssetId ?? null)
      throw new CharacterMismatch(review.correction || review.reason)
    }
    if (payload.imageBudgetKey && sceneImageBudgetKey(job.clipId) !== payload.imageBudgetKey) throw new Error('Adegan atau referensi berubah. Kandidat lama tetap disimpan.')
    activateSceneImage(job.clipId, asset.id, payload.previousImageAssetId ?? null)
  } else if (payload.target === 'clip-video' && job.clipId) {
    const patch = { videoAssetId: asset.id, motionType: 'video' as const, mediaInMs: 0 }
    patchClip(job.clipId, patch)
    emit.clip({ clipId: job.clipId, patch })
  }
  touchProject(job.projectId)
  return asset.id
}

function startHiggsfield(job: Job, build: (ctx: TaskCtx, correction?: string) => Promise<{ endpoint: string; body: Record<string, unknown>; payload: HfPayload }>): Job {
  emit.job(job)
  return runJob(job, 'higgsfield', async (ctx) => {
    let correction = ''
    const originalActive = job.clipId ? getClip(job.clipId).imageAssetId : null
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx.signal.throwIfAborted()
      ctx.progress(0.04, 'Menyiapkan prompt')
      const { endpoint, body, payload } = await build(ctx, correction)
      if (payload.target === 'clip-image') payload.previousImageAssetId = originalActive
      if (job.kind === 'image' && job.clipId && requiresReview(job.projectId)) {
        payload.imageBudgetKey = sceneImageBudgetKey(job.clipId)
        if (!reserveImageAttempt(payload.imageBudgetKey, job.clipId)) return selectBudgetCandidate(job.clipId, payload.imageBudgetKey, originalActive)
      }
      ctx.progress(0.08, 'Mengirim ke Higgsfield')
      const requestId = await hf.submit(endpoint, body, ctx.signal)
      ctx.setRemote(requestId)
      updateJobPayload(job.id, payload)
      try { return await finishHiggsfield(ctx, job, requestId, payload) }
      catch (e) {
        if (!(e instanceof CharacterMismatch)) throw e
        if (attempt === 2 && job.clipId && payload.imageBudgetKey) return selectBudgetCandidate(job.clipId, payload.imageBudgetKey, originalActive)
        correction = e.correction
      }
    }
    throw new Error('Karakter belum lolos setelah tiga kandidat. Export tetap ditahan.')
  })
}

function updateJobPayload(jobId: string, payload: HfPayload): void {
  getDb().prepare('UPDATE jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), jobId)
}

function startNineRouterImage(job: Job, build: (ctx: TaskCtx) => Promise<{ prompt: string; references?: string[]; model?: string }>): Job {
  emit.job(job)
  return runJob(job, '9router-image', async (ctx) => {
    ctx.progress(0.1, 'Menyiapkan prompt gambar')
    const input = await build(ctx)
    ctx.progress(0.2, 'Mengirim ke 9Router Image Generator')
    const s = getSettings()
    const model = input.model || s.nineRouterImageModel || DEFAULT_NINE_ROUTER_IMAGE_MODEL
    const project = getProject(job.projectId)
    const size = project.aspectRatio === '9:16' ? '1024x1792' : '1792x1024'
    const originalActive = job.clipId ? getClip(job.clipId).imageAssetId : null
    const budgetKey = job.clipId && requiresReview(job.projectId) ? sceneImageBudgetKey(job.clipId) : null
    let correction = ''
    for (let attempt = 0; attempt < 3; attempt++) {
    ctx.signal.throwIfAborted()
    if (budgetKey && !reserveImageAttempt(budgetKey, job.clipId!)) return selectBudgetCandidate(job.clipId!, budgetKey, originalActive)
    const prompt = input.prompt + (correction ? '\n\nREPAIR the previous identity error while preserving the scene: ' + correction + '\nUse the supplied original sheets, never a rejected character variant.' : '')
    const { bytes, contentType } = await ninerouter.generateImage(prompt, model, size, ctx.signal, input.references)
    ctx.progress(0.85, 'Menyimpan gambar hasil')
    const ext = contentType.includes('png') ? '.png' : contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg' : '.webp'
    const rel = saveFile(job.projectId, 'images', ext, bytes)
    const abs = assetAbsPath(job.projectId, rel)
    const sizeProbe = await probeSize(abs)
    const asset = insertAsset({
      projectId: job.projectId,
      clipId: job.clipId,
      characterId: job.characterId,
      kind: 'image',
      provider: '9router',
      model,
      prompt,
      localPath: rel,
      width: sizeProbe?.width ?? null,
      height: sizeProbe?.height ?? null,
      meta: budgetKey ? { imageBudgetKey: budgetKey } : {}
    })
    emit.asset(asset)
    if (job.characterId) {
      setCharacterSheet(job.characterId, asset.id)
      emit.character({ characterId: job.characterId, patch: { sheetAssetId: asset.id } })
    } else if (job.clipId) {
      ctx.progress(0.94, 'Membandingkan karakter dengan referensi, kandidat ' + (attempt + 1) + '/3')
      const review = await reviewCharacterCandidate(job.clipId, asset.id, ctx.signal)
      if (review.verdict !== 'pass') {
        correction = review.correction || review.reason
        if (attempt === 2 && budgetKey) return selectBudgetCandidate(job.clipId, budgetKey, originalActive)
        continue
      }
      if (budgetKey && sceneImageBudgetKey(job.clipId) !== budgetKey) throw new Error('Adegan atau referensi berubah. Kandidat lama tetap disimpan.')
      activateSceneImage(job.clipId, asset.id, originalActive)
    }
    touchProject(job.projectId)
    ctx.progress(1, 'Selesai')
    return asset.id
    }
    throw new Error('Karakter belum lolos setelah tiga kandidat. Export tetap ditahan.')
  })
}

// ---------- public entry points ----------

export function generateClipImage(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'image')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const s = getSettings()
  const useNineRouter = (project.imageProvider ?? s.imageProvider) === '9router'
  // Queue sheets before acquiring image slots; otherwise image jobs can wait on sheets behind themselves.
  for (const c of charactersOf(project.id)) if (!c.referenceImageAssetId && !c.sheetAssetId) generateCharacterSheet(c.id)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'image', provider: useNineRouter ? '9router' : 'higgsfield' })
  if (useNineRouter) {
    return startNineRouterImage(job, async (ctx) => {
      const fresh = getClip(clipId)
      const proj = getProject(fresh.projectId)
      const allChars = charactersOf(proj.id)
      await waitForSheets(allChars.map(c => c.id), ctx.signal)
      const refs = characterReferences(fresh)
      const anchor = styleReference(proj.id)
      const configured = supportsNineRouterImageReferences(proj.imageModel || '') ? proj.imageModel! : s.nineRouterImageModel || DEFAULT_NINE_ROUTER_IMAGE_MODEL
      const references = [...refs.map(r => r.url), ...(anchor ? [imageData(anchor).url] : [])]
      const model = references.length && !supportsNineRouterImageReferences(configured) ? 'cx/gpt-image-2.5' : configured
      const chars = sceneCharacters(fresh, allChars)
      const refNames = references.length ? refs.map(r => r.character.name) : []
      const prompt = clipPrompt(proj, fresh, chars, refNames, Number.MAX_SAFE_INTEGER, anchor && references.length ? references.length : undefined, isFluxImageModel(model) ? 0 : 1)
      return { prompt, references, model }
    })
  }
  return startHiggsfield(job, async (ctx, correction) => {
    const fresh = getClip(clipId)
    const proj = getProject(fresh.projectId)
    const model = getImageModel(proj.imageModel)
    await waitForSheets(charactersOf(proj.id).map(c => c.id), ctx.signal)
    const chars = sceneCharacters(fresh, charactersOf(proj.id))
    const anchor = styleReference(proj.id)
    if (chars.length + (anchor ? 1 : 0) > maxRefs(model)) throw new Error('Model tidak cukup menampung seluruh referensi karakter dan acuan gaya.')
    const refs = await referenceUrls(model, chars, ctx.signal)
    if (anchor) { imageData(anchor); refs.urls.push(await publicUrlFor(anchor, ctx.signal)) }
    const prompt = clipPrompt(proj, fresh, chars, refs.names, promptLimit(model), anchor ? refs.urls.length : undefined) + (correction ? '\nRepair character/style errors: ' + correction : '')
    return {
      endpoint: model.id,
      body: imageBody(model, prompt, proj.aspectRatio, refs.urls),
      payload: { target: 'clip-image', model: model.id, prompt, previousImageAssetId: fresh.imageAssetId }
    }
  })
}

export function generateCharacterSheet(characterId: string): Job {
  const existing = activeJobFor({ characterId }, 'sheet')
  if (existing) return existing
  const c = getCharacter(characterId)
  const project = getProject(c.projectId)
  const s = getSettings()
  const useNineRouter = (project.imageProvider ?? s.imageProvider) === '9router'
  const job = insertJob({ projectId: c.projectId, characterId, kind: 'sheet', provider: useNineRouter ? '9router' : 'higgsfield' })
  if (useNineRouter) {
    return startNineRouterImage(job, async () => {
      const proj = getProject(c.projectId)
      const prompt = sheetPrompt(proj, getCharacter(characterId))
      return { prompt }
    })
  }
  return startHiggsfield(job, async () => {
    const proj = getProject(c.projectId)
    const model = getImageModel(proj.imageModel)
    const prompt = sheetPrompt(proj, getCharacter(characterId))
    return {
      endpoint: model.id,
      body: imageBody(model, prompt, '16:9', []),
      payload: { target: 'sheet', model: model.id, prompt }
    }
  })
}

export function generateClipVideo(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'video')
  if (existing) return existing
  const clip = getClip(clipId)
  if (!sceneImageId(clip)) throw new Error('Buat gambar klip ini dulu sebelum membuat video AI.')
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'video', provider: 'higgsfield' })
  return startHiggsfield(job, async (ctx) => {
    const fresh = getClip(clipId)
    const image = getAsset(sceneImageId(fresh))
    if (!image) throw new Error('Gambar klip tidak ditemukan')
    const project = getProject(fresh.projectId)
    const model = getVideoModel(project.videoModel)
    ctx.progress(0.05, 'Menyiapkan gambar awal')
    const url = await publicUrlFor(image, ctx.signal)
    let prompt =
      fresh.videoPrompt.trim() ||
      `${splitAvoid(fresh.visualPrompt).scene.replace(/\.$/, '')}. Subtle natural motion of the characters and environment, the camera slowly pushes in. Keep the art style of the first frame.`
    if (model.input.mode === 'reference')
      prompt = `Open on the exact scene of the reference image and keep its art style, characters and composition. ${prompt}`
    return {
      endpoint: model.id,
      body: videoBody(model, prompt, url, fresh.durationMs / 1000, project.aspectRatio, project.videoResolution),
      payload: { target: 'clip-video', model: model.id, prompt }
    }
  })
}

export function generateClipTts(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'tts')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'tts', provider: project.ttsProvider })
  emit.job(job)
  return runJob(job, 'tts', async (ctx) => {
    const fresh = getClip(clipId)
    const p = getProject(fresh.projectId)
    const text = fresh.narration.trim()
    if (!text) throw new Error('Naskah klip ini masih kosong')
    ctx.progress(0.2, 'Membuat suara')
    let rel: string
    let words: WordTiming[] | undefined
    let estimated = false
    const voice = p.ttsVoice || (p.ttsProvider === 'gemini' ? 'Charon' : p.ttsProvider === '9router' ? (getSettings().nineRouterTtsModel || 'gemini/gemini-3.8-flash-tts') : '')
    if (p.ttsProvider === 'elevenlabs') {
      if (!voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
      const out = await eleven.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.mp3', out.audio)
      words = out.words
    } else if (p.ttsProvider === '9router') {
      const audio = await ninerouter.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.wav', audio)
    } else {
      const wav = await gemini.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.wav', wav)
    }
    ctx.progress(0.85, 'Mengukur durasi')
    const audioMs = await probeDurationMs(assetAbsPath(p.id, rel))
    if (!words?.length) {
      words = estimateWordTimings(stripVoiceTags(text), audioMs / 1000)
      estimated = true
    }
    const asset = insertAsset({
      projectId: p.id,
      clipId,
      kind: 'audio',
      provider: p.ttsProvider,
      model: p.ttsProvider === 'gemini' ? getSettings().geminiTtsModel : p.ttsProvider === '9router' ? (getSettings().nineRouterTtsModel || voice) : getSettings().elevenModel,
      prompt: text,
      localPath: rel,
      durationMs: audioMs,
      meta: { words, estimatedTimings: estimated, voice }
    })
    emit.asset(asset)
    const durationMs = Math.max(1500, audioMs + 400)
    const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
    patchClip(clipId, patch)
    emit.clip({ clipId, patch })
    touchProject(p.id)
    return asset.id
  })
}

export function generateMissingImages(projectId: string): Job[] {
  const jobs: Job[] = []
  const project = getProject(projectId)
  const model = getImageModel(project.imageModel)
  if (maxRefs(model) > 0) {
    const needed = new Set(clipsOf(projectId).flatMap((c) => c.characterIds))
    for (const c of charactersOf(projectId)) {
      if (needed.has(c.id) && !c.referenceImageAssetId && !c.sheetAssetId) jobs.push(generateCharacterSheet(c.id))
    }
  }
  for (const clip of clipsOf(projectId)) {
    if (!sceneImageId(clip)) jobs.push(generateClipImage(clip.id))
  }
  return jobs
}

/** Turns every clip that has an image but no AI video yet into a video. */
export function generateMissingVideos(projectId: string): Job[] {
  const clips = clipsOf(projectId)
  if (clips.some((c) => !sceneImageId(c))) throw new Error('Buat gambar semua klip dulu sebelum menjadikannya video.')
  return clips.filter((c) => !c.videoAssetId).map((c) => generateClipVideo(c.id))
}

export function generateMissingTts(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.audioAssetId && c.narration.trim())
    .map((c) => generateClipTts(c.id))
}

/** After a restart, keep polling Higgsfield requests that were already submitted; fail the rest. */
export function resumeJobs(): void {
  for (const row of unfinishedJobs()) {
    const payload = JSON.parse(row.payload_json || '{}') as Partial<HfPayload>
    if (row.provider === 'higgsfield' && row.remote_id && payload.target) {
      const job = getJob(row.id)!
      runJob(job, 'higgsfield', (ctx) => finishHiggsfield(ctx, job, row.remote_id, payload as HfPayload))
    } else {
      emit.job(updateJob(row.id, { status: 'failed', error: 'Terhenti karena aplikasi ditutup. Coba lagi.', message: null }))
    }
  }
}

export async function setActiveAsset(clipId: string, assetId: string): Promise<void> {
  const asset = getAsset(assetId)
  const clip = getClip(clipId)
  if (!asset || asset.projectId !== clip.projectId || (asset.kind !== 'image' && asset.clipId !== clipId)) {
    throw new Error('Aset tidak cocok dengan klip ini')
  }
  const patch: Partial<Clip> =
    asset.kind === 'image'
      ? { imageAssetId: asset.id }
      : asset.kind === 'video'
        ? { videoAssetId: asset.id, mediaInMs: 0 }
        : asset.kind === 'audio'
          ? { audioAssetId: asset.id, durationMs: Math.max(1500, (asset.durationMs ?? 0) + 400), voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
          : {}
  patchClip(clipId, patch)
  emit.clip({ clipId, patch })
}

/** Estimates that failed recently (no key, or a model the account cannot use), so pickers do not keep asking. */
const failedEstimates = new Map<string, number>()

/**
 * Credits for one image, or one clip video of about `seconds`. The model pickers ask for every model,
 * so answers are kept for a day and failures for ten minutes.
 */
export async function estimateCredits(
  kind: 'image' | 'video',
  modelId: string,
  aspect: AspectRatio,
  seconds = 5,
  resolution?: string | null
): Promise<CreditEstimate | null> {
  const model = kind === 'image' ? getImageModel(modelId) : getVideoModel(modelId)
  const body =
    kind === 'image'
      ? imageBody(model, 'estimate', aspect, [])
      : videoBody(model, 'estimate', 'https://example.com/frame.png', seconds, aspect, resolution)
  const key = `estimate:${model.id}:${JSON.stringify(body)}`
  const hit = readCache<CreditEstimate>(key)
  if (hit && Date.now() - hit.updatedAt < DAY) return hit.value
  const failedAt = failedEstimates.get(key)
  if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) return null
  const value = await hf.estimate(model.id, body)
  if (value) writeCache(key, value)
  else failedEstimates.set(key, Date.now())
  return value
}

/** Prices can differ per account, so a new Higgsfield key starts from fresh estimates. */
export function forgetEstimates(): void {
  failedEstimates.clear()
  dropCache('estimate:')
}
