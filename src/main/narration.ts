import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { WHISPER_TIMING, captionNeedsSync, estimateWordTimings } from '@shared/captions'
import { estimateNarrationMs } from '@shared/script'
import { spokenWords, stripVoiceTags } from '@shared/speech'
import type { Clip, Job, Project, WordTiming } from '@shared/types'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { assetAbsPath, binPath, dataDir } from './paths'
import {
  activeProjectJob,
  clipsOf,
  getAsset,
  getClip,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  touchProject,
  updateAssetMeta
} from './repo'
import { getSettings } from './settings'
import { chooseCuts, cutsFromWords } from './cuts'
import { probeDurationMs } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import * as ninerouter from './services/ninerouter'
import { timeScript, whisperReady, whisperStatus } from './whisper'
import { getDb } from './db'
import { getJob } from './repo'

/**
 * Voices many scenes in one continuous take and cuts it per scene. A single take keeps the voice, pace and
 * intonation consistent, which separate requests per scene do not. Long scripts are voiced in parts of a
 * few minutes each.
 */

const GEMINI_PART_SEC = 240
const ELEVEN_PART_CHARS = 2400

interface Segment {
  clip: Clip
  file: string
  durationMs: number
  words: WordTiming[]
  estimated: boolean
  timedBy?: string
}

function ffmpeg(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile(binPath(ffmpegStatic!), ['-hide_banner', '-nostats', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, _out, stderr) => {
      if (signal.aborted) return reject(new Error('Dibatalkan'))
      if (err) return reject(new Error(`FFmpeg gagal: ${String(stderr).split('\n').slice(-4).join(' ').trim()}`))
      resolve(String(stderr))
    })
    signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true })
  })
}

async function detectSilences(file: string, signal: AbortSignal): Promise<{ start: number; end: number }[]> {
  const log = await ffmpeg(['-i', file, '-af', 'silencedetect=noise=-38dB:d=0.25', '-f', 'null', '-'], signal)
  const out: { start: number; end: number }[] = []
  let start: number | null = null
  for (const line of log.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) start = Math.max(0, Number(s[1]))
    const e = /silence_end:\s*([\d.]+)/.exec(line)
    if (e && start != null) {
      out.push({ start, end: Number(e[1]) })
      start = null
    }
  }
  return out
}

/** Groups scenes into takes that fit one request, keeping the script order. */
function parts(clips: Clip[], provider: Project['ttsProvider']): Clip[][] {
  const out: Clip[][] = []
  let cur: Clip[] = []
  let size = 0
  for (const c of clips) {
    const s = provider === 'elevenlabs' ? c.narration.length : estimateNarrationMs(c.narration) / 1000
    const limit = provider === 'elevenlabs' ? ELEVEN_PART_CHARS : GEMINI_PART_SEC
    if (cur.length && size + s > limit) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(c)
    size += s
  }
  if (cur.length) out.push(cur)
  return out
}

async function cut(src: string, start: number, end: number, dst: string, signal: AbortSignal): Promise<void> {
  await ffmpeg(['-y', '-i', src, '-ss', start.toFixed(3), '-to', end.toFixed(3), '-c:a', 'pcm_s16le', '-ac', '1', dst], signal)
}

/** Word timings for a take from the local Whisper model, or null when it is off, missing or fails. */
async function whisperTimes(take: string, words: string[], p: Project, total: number, tmp: string, ctx: TaskCtx, note: () => void): Promise<WordTiming[] | null> {
  if (!getSettings().whisperAuto || !whisperReady() || !words.length) return null
  note()
  try {
    return await timeScript(take, words, p.language, total, tmp, ctx.signal)
  } catch (e) {
    if (ctx.signal.aborted) throw e
    // Preserve the paid recording as provisional pieces. ATM must realign their boundaries before export.
    console.warn('[whisper]', (e as Error).message)
    return null
  }
}

async function geminiTake(p: Project, voice: string, group: Clip[], tmp: string, ctx: TaskCtx, note: () => void): Promise<Segment[]> {
  // A long pause between scenes gives the cutter a clear gap to find.
  const wav = await gemini.speak(group.map((c) => c.narration.trim()).join('\n<long pause>\n'), voice, p.language, ctx.signal)
  const take = join(tmp, `take-${randomUUID()}.wav`)
  writeFileSync(take, wav)
  const total = (await probeDurationMs(take)) / 1000
  const silences = await detectSilences(take, ctx.signal)

  // With Whisper, every script word gets its real time, and scene ends come from the words themselves.
  const perScene = group.map((c) => spokenWords(c.narration))
  const timed = await whisperTimes(take, perScene.flat(), p, total, tmp, ctx, note)
  const ranges: WordTiming[][] = []
  let gaps: { end: number; start: number }[] | null = null
  if (timed) {
    let at = 0
    for (const w of perScene) {
      ranges.push(timed.slice(at, at + w.length))
      at += w.length
    }
    gaps = []
    for (let k = 0; k < group.length - 1; k++) {
      const end = ranges[k][ranges[k].length - 1]?.end
      const start = ranges[k + 1][0]?.start
      if (end == null || start == null) {
        gaps = null
        break
      }
      gaps.push({ end, start })
    }
  }
  const cuts = gaps ? cutsFromWords(gaps, silences) : chooseCuts(total, group.map((c) => stripVoiceTags(c.narration).length), silences)
  const bounds = [0, ...cuts, total]
  const out: Segment[] = []
  for (let k = 0; k < group.length; k++) {
    const start = bounds[k]
    const end = bounds[k + 1]
    const len = end - start
    const file = join(tmp, `seg-${randomUUID()}.wav`)
    await cut(take, start, end, file, ctx.signal)
    let words: WordTiming[]
    if (timed) {
      words = ranges[k].map((w) => ({ ...w, start: Math.min(len, Math.max(0, w.start - start)), end: Math.min(len, Math.max(0, w.end - start)) }))
    } else {
      // Spread the words over the spoken part only, not the pauses around it.
      const lead = silences.find((s) => s.start <= start + 0.01 && s.end > start)?.end ?? start
      const tail = silences.find((s) => s.start < end && s.end >= end - 0.01)?.start ?? end
      words = estimateWordTimings(stripVoiceTags(group[k].narration), Math.max(0.3, tail - lead)).map((w) => ({
        ...w,
        start: w.start + (lead - start),
        end: w.end + (lead - start)
      }))
    }
    out.push({ clip: group[k], file, durationMs: Math.round(len * 1000), words, estimated: !timed, timedBy: timed ? WHISPER_TIMING : undefined })
  }
  return out
}

async function nineRouterTake(p: Project, voice: string, group: Clip[], tmp: string, ctx: TaskCtx, note: () => void): Promise<Segment[]> {
  const wav = await ninerouter.speak(group.map((c) => c.narration.trim()).join('\n<long pause>\n'), voice, p.language, ctx.signal)
  const take = join(tmp, `take-${randomUUID()}.wav`)
  writeFileSync(take, wav)
  const total = (await probeDurationMs(take)) / 1000
  const silences = await detectSilences(take, ctx.signal)

  const perScene = group.map((c) => spokenWords(c.narration))
  const timed = await whisperTimes(take, perScene.flat(), p, total, tmp, ctx, note)
  const ranges: WordTiming[][] = []
  let gaps: { end: number; start: number }[] | null = null
  if (timed) {
    let at = 0
    for (const w of perScene) {
      ranges.push(timed.slice(at, at + w.length))
      at += w.length
    }
    gaps = []
    for (let k = 0; k < group.length - 1; k++) {
      const end = ranges[k][ranges[k].length - 1]?.end
      const start = ranges[k + 1][0]?.start
      if (end == null || start == null) {
        gaps = null
        break
      }
      gaps.push({ end, start })
    }
  }
  const cuts = gaps ? cutsFromWords(gaps, silences) : chooseCuts(total, group.map((c) => stripVoiceTags(c.narration).length), silences)
  const bounds = [0, ...cuts, total]
  const out: Segment[] = []
  for (let k = 0; k < group.length; k++) {
    const start = bounds[k]
    const end = bounds[k + 1]
    const len = end - start
    const file = join(tmp, `seg-${randomUUID()}.wav`)
    await cut(take, start, end, file, ctx.signal)
    let words: WordTiming[]
    if (timed) {
      words = ranges[k].map((w) => ({ ...w, start: Math.min(len, Math.max(0, w.start - start)), end: Math.min(len, Math.max(0, w.end - start)) }))
    } else {
      const lead = silences.find((s) => s.start <= start + 0.01 && s.end > start)?.end ?? start
      const tail = silences.find((s) => s.start < end && s.end >= end - 0.01)?.start ?? end
      words = estimateWordTimings(stripVoiceTags(group[k].narration), Math.max(0.3, tail - lead)).map((w) => ({
        ...w,
        start: w.start + (lead - start),
        end: w.end + (lead - start)
      }))
    }
    out.push({ clip: group[k], file, durationMs: Math.round(len * 1000), words, estimated: !timed, timedBy: timed ? WHISPER_TIMING : undefined })
  }
  return out
}

async function elevenTake(
  p: Project,
  voice: string,
  group: Clip[],
  context: { previous?: string; next?: string },
  tmp: string,
  ctx: TaskCtx
): Promise<Segment[]> {
  const r = await eleven.speak(group.map((c) => c.narration.trim()).join('\n\n'), voice, p.language, ctx.signal, context)
  const take = join(tmp, `take-${randomUUID()}.mp3`)
  writeFileSync(take, r.audio)
  const total = (await probeDurationMs(take)) / 1000
  // The alignment gives every spoken word; count them off per scene to find where each one starts and ends.
  const counts = group.map((c) => spokenWords(c.narration).length)
  const expected = counts.reduce((a, b) => a + b, 0)
  const scale = expected ? r.words.length / expected : 1
  const ranges: { first: WordTiming | undefined; last: WordTiming | undefined; words: WordTiming[] }[] = []
  let at = 0
  for (const n of counts) {
    const from = Math.round(at * scale)
    at += n
    const to = Math.max(from, Math.round(at * scale))
    const words = r.words.slice(from, to)
    ranges.push({ first: words[0], last: words[words.length - 1], words })
  }
  const bounds = [0]
  for (let k = 0; k < group.length - 1; k++) {
    const a = ranges[k].last?.end
    const b = ranges[k + 1].first?.start
    bounds.push(a != null && b != null ? (a + b) / 2 : (total * (k + 1)) / group.length)
  }
  bounds.push(total)
  const out: Segment[] = []
  for (let k = 0; k < group.length; k++) {
    const start = bounds[k]
    const end = Math.max(start + 0.3, bounds[k + 1])
    const file = join(tmp, `seg-${randomUUID()}.wav`)
    await cut(take, start, end, file, ctx.signal)
    const words = ranges[k].words.map((w) => ({ ...w, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) }))
    out.push({ clip: group[k], file, durationMs: Math.round((end - start) * 1000), words, estimated: false })
  }
  return out
}

function store(p: Project, s: Segment, voice: string, takeId: string, bytes: Buffer, extraMeta: Record<string, unknown> = {}): void {
  const rel = `audio/${randomUUID()}.wav`
  const abs = assetAbsPath(p.id, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  const asset = insertAsset({
    projectId: p.id,
    clipId: s.clip.id,
    kind: 'audio',
    provider: p.ttsProvider,
    model: p.ttsProvider === 'gemini' ? getSettings().geminiTtsModel : p.ttsProvider === '9router' ? (getSettings().nineRouterTtsModel || voice) : getSettings().elevenModel,
    prompt: s.clip.narration,
    localPath: rel,
    durationMs: s.durationMs,
    meta: { words: s.words, estimatedTimings: s.estimated, voice, take: takeId, ...(s.timedBy ? { timedBy: s.timedBy } : {}), ...extraMeta }
  })
  emit.asset(asset)
  // Each piece already carries half of the pause on either side, so the pieces play back as the one take.
  const durationMs = Math.max(1500, s.durationMs)
  // A new take starts untrimmed at the clip's start.
  const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
  patchClip(s.clip.id, patch)
  emit.clip({ clipId: s.clip.id, patch })
}

/** Reassemble estimated scene cuts, align the full existing recording, and cut on spoken words. No TTS. */
export function realignNarration(projectId: string, idempotencyKey: string): Job {
  const db = getDb()
  const previous = db.prepare("SELECT id FROM jobs WHERE project_id=? AND kind='align' AND json_extract(payload_json,'$.realignKey')=? ORDER BY created_at DESC LIMIT 1").get(projectId, idempotencyKey) as { id: string } | undefined
  if (previous) return getJob(previous.id)!
  if (activeProjectJob(projectId, 'align') || activeProjectJob(projectId, 'narration') || activeProjectJob(projectId, 'export')) throw new Error('Tunggu pekerjaan suara/ekspor aktif selesai.')
  if (!whisperReady()) throw new Error(whisperStatus().error || 'Whisper lokal belum siap.')
  const p = getProject(projectId)
  const clips = clipsOf(projectId)
  const assets = clips.map(c => getAsset(c.audioAssetId))
  if (!clips.length || clips.some((c, i) => !c.narration.trim() || !assets[i] || assets[i]!.prompt !== c.narration || c.voiceInMs || c.voiceOutMs != null || c.voiceStartMs)) throw new Error('Penyelarasan ulang memerlukan seluruh suara asli tanpa trim dengan naskah yang masih cocok.')
  const sourceIds = assets.map(a => a!.id)
  const job = insertJob({ projectId, kind: 'align', provider: 'whisper', payload: { realignKey: idempotencyKey, sourceAssetIds: sourceIds } })
  emit.job(job)
  return runJob(job, 'whisper', async ctx => {
    const tmp = join(dataDir(), 'tmp', `realign-${ctx.jobId}`)
    mkdirSync(tmp, { recursive: true })
    try {
      const list = join(tmp, 'sources.txt')
      writeFileSync(list, assets.map(a => "file '" + assetAbsPath(projectId, a!.localPath).replace(/'/g, "'\\''") + "'").join('\n'))
      const take = join(tmp, 'existing-recording.wav')
      ctx.progress(.02, 'Menggabungkan rekaman tersimpan tanpa membuat suara baru')
      await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', '-ac', '1', take], ctx.signal)
      const total = (await probeDurationMs(take)) / 1000
      const perScene = clips.map(c => spokenWords(c.narration))
      ctx.progress(.08, 'Whisper menyelaraskan seluruh rekaman agar batas adegan mengikuti kata')
      const timed = await timeScript(take, perScene.flat(), p.language, total, tmp, ctx.signal)
      const ranges: WordTiming[][] = []
      let at = 0
      for (const words of perScene) { ranges.push(timed.slice(at, at + words.length)); at += words.length }
      const silence = await detectSilences(take, ctx.signal)
      const cuts = cutsFromWords(ranges.slice(0, -1).map((r, i) => ({ end: r[r.length - 1].end, start: ranges[i + 1][0].start })), silence)
      const bounds = [0, ...cuts, total]
      const segments: Segment[] = []
      for (let i = 0; i < clips.length; i++) {
        const start = bounds[i], end = bounds[i + 1], len = end - start
        if (len < .2 || ranges[i].some(w => w.start < start - .31 || w.end > end + .31)) throw new Error('Batas suara tidak pasti. Rekaman asli dipertahankan untuk pemeriksaan.')
        const file = join(tmp, `scene-${i}.wav`)
        ctx.progress(.8 + .15 * i / clips.length, `Memotong ulang rekaman ${i + 1}/${clips.length}`)
        await cut(take, start, end, file, ctx.signal)
        segments.push({ clip: clips[i], file, durationMs: await probeDurationMs(file), words: ranges[i].map(w => ({ ...w, start: Math.max(0, Math.min(len, w.start - start)), end: Math.max(0, Math.min(len, w.end - start)) })), estimated: false, timedBy: WHISPER_TIMING })
      }
      ctx.signal.throwIfAborted()
      db.transaction(() => {
        if (clips.some((c, i) => { const current = getClip(c.id); return current.audioAssetId !== sourceIds[i] || current.narration !== c.narration })) throw new Error('Project berubah selama penyelarasan; hasil lama tetap dipertahankan.')
        for (let i = 0; i < segments.length; i++) store(p, segments[i], String(assets[i]!.meta.voice || p.ttsVoice || ''), ctx.jobId, readFileSync(segments[i].file), { boundaryRealigned: true, sourceAssetId: sourceIds[i], realignJobId: ctx.jobId })
        touchProject(projectId)
      }).immediate()
      return { message: `${clips.length} batas adegan diperbaiki dari rekaman tersimpan; tanpa TTS baru` }
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
}

/** Voices the scenes that need it ("missing") or every scene ("all") as one continuous take. */
export function generateNarration(projectId: string, mode: 'missing' | 'all'): Job {
  const running = activeProjectJob(projectId, 'narration')
  if (running) return running
  const project = getProject(projectId)
  const targets = clipsOf(projectId).filter((c) => c.narration.trim() && (mode === 'all' || !c.audioAssetId))
  if (!targets.length) throw new Error('Tidak ada naskah narasi yang perlu disuarakan.')
  const job = insertJob({ projectId, kind: 'narration', provider: project.ttsProvider, payload: { mode, clipIds: targets.map((c) => c.id) } })
  emit.job(job)
  return runJob(job, 'tts', async (ctx) => {
    const p = getProject(projectId)
    const voice = p.ttsVoice || (p.ttsProvider === 'gemini' ? 'Charon' : p.ttsProvider === '9router' ? (getSettings().nineRouterTtsModel || 'gemini/gemini-3.8-flash-tts') : '')
    if (p.ttsProvider === 'elevenlabs' && !voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
    const clips = targets.map((c) => getClip(c.id)).filter((c) => c.narration.trim())
    const groups = parts(clips, p.ttsProvider)
    const tmp = join(dataDir(), 'tmp', `narration-${ctx.jobId}`)
    mkdirSync(tmp, { recursive: true })
    const takeId = randomUUID()
    try {
      let done = 0
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g]
        ctx.progress(0.05 + 0.85 * (done / clips.length), groups.length > 1 ? `Membuat suara bagian ${g + 1} dari ${groups.length}` : 'Membuat suara narasi')
        const segments =
          p.ttsProvider === 'elevenlabs'
            ? await elevenTake(
                p,
                voice,
                group,
                { previous: groups[g - 1]?.map((c) => c.narration).join('\n\n'), next: groups[g + 1]?.map((c) => c.narration).join('\n\n') },
                tmp,
                ctx
              )
            : p.ttsProvider === '9router'
              ? await nineRouterTake(p, voice, group, tmp, ctx, () =>
                  ctx.progress(0.05 + 0.85 * ((done + group.length * 0.6) / clips.length), 'Menyinkronkan caption dengan Whisper')
                )
              : await geminiTake(p, voice, group, tmp, ctx, () =>
                  ctx.progress(0.05 + 0.85 * ((done + group.length * 0.6) / clips.length), 'Menyinkronkan caption dengan Whisper')
                )
        ctx.progress(0.05 + 0.85 * ((done + group.length * 0.9) / clips.length), 'Memotong suara per adegan')
        for (const s of segments) store(p, s, voice, takeId, readFileSync(s.file))
        done += group.length
      }
      touchProject(projectId)
      return { message: `${clips.length} adegan disuarakan dalam satu rekaman` }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

/**
 * Re-times caption words with the local Whisper model on each scene's audio: scenes whose timings are
 * estimates or came from an older Whisper method, or every Gemini-voiced scene with "all".
 */
export function syncCaptions(projectId: string, mode: 'stale' | 'all' = 'stale'): Job {
  const running = activeProjectJob(projectId, 'align')
  if (running) return running
  if (!whisperReady()) throw new Error(whisperStatus().error || 'Model Whisper belum diunduh. Unduh dulu di Pengaturan, bagian Caption akurat.')
  const targets = clipsOf(projectId).filter((c) => {
    const a = getAsset(c.audioAssetId)
    return !!a && (mode === 'all' ? a.provider !== 'elevenlabs' : captionNeedsSync(a))
  })
  if (!targets.length) throw new Error('Semua caption sudah memakai waktu dari suara aslinya.')
  const job = insertJob({ projectId, kind: 'align', provider: 'whisper' })
  emit.job(job)
  return runJob(job, 'whisper', async (ctx) => {
    const project = getProject(projectId)
    const tmp = join(dataDir(), 'tmp', `align-${ctx.jobId}`)
    try {
      for (let i = 0; i < targets.length; i++) {
        ctx.progress(0.03 + 0.95 * (i / targets.length), `Menyinkronkan klip ${i + 1} dari ${targets.length}`)
        const asset = getAsset(getClip(targets[i].id).audioAssetId)
        if (!asset) continue
        const words = spokenWords(asset.prompt ?? targets[i].narration)
        if (!words.length) continue
        const seconds = (asset.durationMs ?? targets[i].durationMs) / 1000
        const timed = await timeScript(assetAbsPath(projectId, asset.localPath), words, project.language, seconds, tmp, ctx.signal)
        updateAssetMeta(asset.id, { ...asset.meta, words: timed, estimatedTimings: false, timedBy: WHISPER_TIMING })
        emit.asset(getAsset(asset.id)!)
      }
      return { message: `${targets.length} klip disinkronkan` }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}
