import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import {
  ARABIC_FALLBACK_FONT,
  CAPTION_BOX_PAD,
  CAPTION_BOX_RADIUS,
  CAPTION_MAX_WIDTH,
  captionFontFile,
  captionScaleOf,
  layoutCaptionLines,
  roundedRectPath,
  POPPINS_CELL,
  displayWord,
  resolveCaption,
  timelineChunks,
  type CaptionChunk,
  type ResolvedCaption
} from '@shared/captions'
import { cameraPerspective, TRANSITIONS, transitionSecOf } from '@shared/motion'
import { clipCaptionWords } from '@shared/timeline'
import { anchorOffset, contrastColor, overlayEnd, textEffects } from '@shared/overlays'
import type { Asset, Clip, ExportOptions, ImageOverlay, Job, ProjectBundle, TextOverlay } from '@shared/types'
import { emit } from './events'
import { audioInputHash, prepareAudioMix } from './soundDesign'
import { runJob, type TaskCtx } from './jobs'
import { fontChain } from './fontMetrics'
import { assetAbsPath, binPath, dataDir, fontsDir } from './paths'
import { getBundle, insertJob, touchProject, updateEditorSettings } from './repo'
import { videoGroups, videoJoinGraph, type VideoPart } from './exportVideo'
import { sceneImageFit, sceneImageId, sceneVideoId } from '@shared/flowV2'
import { assertCharacterConsistency } from './characterConsistency'

function ffmpegPath(): string {
  if (!ffmpegStatic) throw new Error('FFmpeg tidak ditemukan di aplikasi')
  return binPath(ffmpegStatic)
}

function outputSize(aspect: '16:9' | '9:16', res: ExportOptions['resolution']): { w: number; h: number } {
  const long = res === 720 ? 1280 : res === 1080 ? 1920 : 3840
  const short = res
  return aspect === '16:9' ? { w: long, h: short } : { w: short, h: long }
}

/** Runs ffmpeg in `cwd`, reporting progress from its `time=` output against `totalSec`. */
function runFfmpeg(args: string[], cwd: string, signal: AbortSignal, totalSec?: number, onProgress?: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-y', '-filter_threads', '2', '-filter_complex_threads', '2', ...args], { cwd, windowsHide: true })
    let tail = ''
    const onAbort = (): void => {
      p.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort)
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      tail = (tail + s).slice(-4000)
      if (totalSec && onProgress) {
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s)
        if (m) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / totalSec))
      }
    })
    p.on('error', reject)
    p.on('close', (code, killedBy) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new Error('Dibatalkan'))
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg gagal (${killedBy ? 'sinyal ' + killedBy : 'kode ' + code}): ${tail.split('\n').slice(-6).join(' ').trim()}`))
    })
  })
}

// ---------- captions ----------

const FONT_BY_WEIGHT: Record<number, { name: string; bold: number }> = {
  500: { name: 'Poppins Medium', bold: 0 },
  600: { name: 'Poppins SemiBold', bold: 0 },
  700: { name: 'Poppins', bold: -1 },
  800: { name: 'Poppins ExtraBold', bold: 0 }
}

/** #RRGGBB + opacity → ASS &HAABBGGRR */
function assColor(hex: string, opacity = 1): string {
  const h = hex.replace('#', '')
  const a = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, '0')
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase()
}

function assInlineColor(hex: string): string {
  const h = hex.replace('#', '')
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase()
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

const escapeAss = (t: string): string => t.replace(/\\/g, '\\\\').replace(/[{}]/g, '')

interface CaptionTrack {
  chunks: CaptionChunk[]
  style: ResolvedCaption
  pos: string
  sizeScale: number
}

/** Overlay text styles; each line then sets its own size, colors and position with override tags. */
const OVERLAY_STYLES = [
  'Style: OvPlain,Poppins,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8F000000,-1,0,0,0,100,100,0,0,1,0,2,5,0,0,0,1',
  'Style: OvOutline,Poppins,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,0,0,0,1',
  'Style: OvBox,Poppins,48,&H00FFFFFF,&H00FFFFFF,&HFF000000,&H26000000,-1,0,0,0,100,100,0,0,4,12,0,5,0,0,0,1'
]

/** One Dialogue line per text overlay, placed with \an (anchor) and \pos like the editor preview. */
function overlayEvents(texts: TextOverlay[], total: number, w: number, h: number): string[] {
  const out: string[] = []
  for (const o of texts) {
    const end = overlayEnd(o, total)
    if (end <= o.start || !o.text.trim()) continue
    const px = o.size * h
    const fs = Math.max(8, Math.round(px * POPPINS_CELL))
    const fx = textEffects(o.style, px)
    const style = o.style === 'box' ? 'OvBox' : o.style === 'outline' ? 'OvOutline' : 'OvPlain'
    const tags = [
      `\\an${o.anchor}`,
      `\\pos(${Math.round(o.x * w)},${Math.round(o.y * h)})`,
      '\\q2',
      `\\fs${fs}`,
      o.bold ? '\\fnPoppins\\b1' : '\\fnPoppins Medium\\b0',
      `\\c${assInlineColor(o.color)}`
    ]
    if (o.style === 'box') tags.push(`\\bord${fx.pad}`, `\\4c${assInlineColor(contrastColor(o.color))}`, '\\4a&H26&')
    if (o.style === 'outline') tags.push(`\\bord${fx.outline}`, `\\3c${assInlineColor(contrastColor(o.color))}`)
    if (o.style === 'plain') tags.push('\\bord0', `\\shad${fx.shadow}`)
    const text = escapeAss(o.text).replace(/\r?\n/g, '\\N')
    out.push(`Dialogue: 2,${assTime(o.start)},${assTime(end)},${style},,0,0,0,,{${tags.join('')}}${text}`)
  }
  return out
}

/** The subtitle file burned into the video: optional captions (box on layer 0, text on 1) and overlay text above them (layer 2). */
function buildAss(captions: CaptionTrack | null, texts: TextOverlay[], total: number, w: number, h: number): string {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...(captions ? captionStyleLines(captions, w, h) : []),
    ...OVERLAY_STYLES,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...(captions ? captionEvents(captions, w, h) : []),
    ...overlayEvents(texts, total, w, h)
  ]
  return lines.join('\n') + '\n'
}

/** Caption size in pixels (one em), the vertical margin and the box padding for a frame of height h. */
function captionMetrics({ style, sizeScale }: CaptionTrack, h: number): { px: number; marginV: number; pad: number } {
  const px = style.size * h * sizeScale
  return { px, marginV: Math.round(h * 0.07), pad: style.box ? px * CAPTION_BOX_PAD : 0 }
}

function captionStyleLines(track: CaptionTrack, w: number, h: number): string[] {
  const { style, pos } = track
  // Poppins comes in several weight files; the other caption fonts have a single one.
  const font = style.fontInfo.id === 'poppins' ? (FONT_BY_WEIGHT[style.weight] ?? FONT_BY_WEIGHT[700]) : { name: style.fontInfo.family, bold: 0 }
  const { px, marginV } = captionMetrics(track, h)
  const size = Math.round(px * style.fontInfo.cell)
  const boxed = !!style.box
  const align = pos === 'atas' ? 8 : pos === 'tengah' ? 5 : 2
  // A boxed caption is plain text over its own rounded box (CapBox); libass can only draw square boxes.
  const outline = boxed ? 0 : Math.max(1, Math.round(style.outline * h))
  const outlineColor = boxed ? '&HFF000000' : assColor(style.outlineColor)
  const side = Math.round((w * (1 - CAPTION_MAX_WIDTH)) / 2)
  const lines = [
    `Style: Cap,${font.name},${size},${assColor(style.color)},${assColor(style.color)},${outlineColor},&HFF000000,${font.bold},0,0,0,100,100,0,0,1,${outline},0,${align},${side},${side},${marginV},1`
  ]
  if (boxed) lines.push(`Style: CapBox,${font.name},${size},${assColor(style.box!, style.boxAlpha)},&H00FFFFFF,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`)
  return lines
}

function captionEvents(track: CaptionTrack, w: number, h: number): string[] {
  const { chunks, style, pos } = track
  const { px, marginV, pad } = captionMetrics(track, h)
  // Measure with the caption font first, then the bundled Arabic face: libass falls back the same way,
  // so the box width and line breaks match what it draws for non-Latin scripts.
  const fallback = join(fontsDir(), ARABIC_FALLBACK_FONT)
  const measure = fontChain([join(fontsDir(), captionFontFile(style)), ...(existsSync(fallback) ? [fallback] : [])])
  const lineH = px * style.fontInfo.cell
  const lines: string[] = []
  const base = assInlineColor(style.color)
  const hl = assInlineColor(style.highlight)
  const highlight = style.highlight.toLowerCase() !== style.color.toLowerCase()
  chunks.forEach((c, i) => {
    const next = chunks[i + 1]
    const holdUntil = next ? Math.min(next.start, c.end + 0.6) : c.end + 0.6
    const shown = c.words.map((x) => displayWord(x.text, style))
    // The same line breaks as the preview, written out so libass does not wrap on its own.
    const layout = layoutCaptionLines(shown, (t) => measure(t) * px, w * CAPTION_MAX_WIDTH)
    const breaks = new Set<number>()
    let count = 0
    for (const l of layout.slice(0, -1)) breaks.add((count += l.length))
    const words = shown.map((t) => escapeAss(t))
    const textOf = (color: (k: number) => string): string =>
      words.map((_, k) => `${k === 0 ? '' : breaks.has(k) ? '\\N' : ' '}${color(k)}`).join('')

    if (style.box) {
      const textW = Math.max(...layout.map((l) => measure(l.join(' ')) * px))
      const textH = layout.length * lineH
      const top = pos === 'atas' ? marginV : pos === 'tengah' ? (h - textH) / 2 : h - marginV - textH
      const path = roundedRectPath(w / 2 - textW / 2 - pad, top - pad, w / 2 + textW / 2 + pad, top + textH + pad, px * CAPTION_BOX_RADIUS)
      lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(holdUntil)},CapBox,,0,0,0,,{\\an7\\pos(0,0)\\p1}${path}`)
    }
    if (!highlight) {
      lines.push(`Dialogue: 1,${assTime(c.start)},${assTime(holdUntil)},Cap,,0,0,0,,${textOf((k) => words[k])}`)
      return
    }
    c.words.forEach((wd, j) => {
      const start = j === 0 ? c.start : wd.start
      const end = j + 1 < c.words.length ? c.words[j + 1].start : holdUntil
      if (end <= start) return
      lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${textOf((k) => (k === j ? `{\\c${hl}}${words[k]}{\\c${base}}` : words[k]))}`)
    })
  })
  return lines
}

function buildSrt(chunks: CaptionChunk[]): string {
  return (
    chunks
      .map((c, i) => {
        const next = chunks[i + 1]
        const end = next ? Math.min(next.start, c.end + 0.6) : c.end + 0.6
        return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(end)}\n${c.words.map((w) => w.text).join(' ')}\n`
      })
      .join('\n') + '\n'
  )
}

// ---------- timeline ----------

interface Segment {
  clip: Clip
  start: number
  own: number
  overlap: number
  /** Extra frames rendered past the transition, so xfade never runs out of the first clip. */
  pad: number
  transition: string
}

/**
 * Places clips on whole frames. xfade stops the whole video when the first clip ends before the transition
 * offset, which happens with a one-frame cut whose offset falls between two frames. Frame-aligned starts
 * plus two spare frames per segment keep every transition inside the footage.
 */
function planSegments(clips: Clip[], fps: number): Segment[] {
  let t = 0
  const frames = clips.map((clip) => {
    const startF = Math.round(t * fps)
    t += clip.durationMs / 1000
    return { startF, endF: Math.max(startF + 1, Math.round(t * fps)) }
  })
  return clips.map((clip, i) => {
    const { startF, endF } = frames[i]
    const last = i === clips.length - 1
    const tr = TRANSITIONS.find((x) => x.id === clip.transition)
    let overlapF = 0
    if (!last) {
      // The clip's own transition length, never longer than either clip it joins.
      const room = Math.max(1, Math.min(endF - startF, frames[i + 1].endF - frames[i + 1].startF) - 1)
      overlapF = tr?.ffmpeg ? Math.min(room, Math.max(1, Math.round(transitionSecOf(clip) * fps))) : 1
    }
    return {
      clip,
      start: startF / fps,
      own: (endF - startF) / fps,
      overlap: overlapF / fps,
      pad: last ? 0 : 2 / fps,
      transition: tr?.ffmpeg ?? 'fade'
    }
  })
}

/**
 * The size a camera move is rendered at before the final scale: the source's own detail, cropped to the frame,
 * so the move resamples real pixels once. Never below the output size, and at most twice it.
 */
function workSize(srcW: number | null | undefined, srcH: number | null | undefined, size: { w: number; h: number }): { w: number; h: number } {
  if (!srcW || !srcH) return size
  const aspect = size.w / size.h
  const cropW = srcW / srcH > aspect ? srcH * aspect : srcW
  const f = Math.min(2, Math.max(1, cropW / size.w))
  return { w: Math.round((size.w * f) / 2) * 2, h: Math.round((size.h * f) / 2) * 2 }
}

/** Scale and crop to the work size, the camera move, then down to the output size. */
function cameraChain(cam: string | null, work: { w: number; h: number }, size: { w: number; h: number }, between: string[] = [], fit: 'cover' | 'contain' = 'cover'): string {
  return [
    `scale=${work.w}:${work.h}:force_original_aspect_ratio=${fit === 'contain' ? 'decrease' : 'increase'}:flags=lanczos`,
    fit === 'contain' ? `pad=${work.w}:${work.h}:(ow-iw)/2:(oh-ih)/2:black` : `crop=${work.w}:${work.h}`,
    'setsar=1',
    ...between,
    ...(cam ? [cam] : []),
    ...(work.w !== size.w || work.h !== size.h ? [`scale=${size.w}:${size.h}:flags=lanczos`, 'setsar=1'] : []),
    'format=yuv420p'
  ].join(',')
}

/** An audio length to assume when an older asset never recorded its duration. */
const UNKNOWN_AUDIO_MS = 10 * 60 * 1000

function assetOf(bundle: ProjectBundle, id: string | null): Asset | undefined {
  return id ? bundle.assets.find((a) => a.id === id) : undefined
}

async function renderSegment(
  bundle: ProjectBundle,
  seg: Segment,
  index: number,
  opts: ExportOptions,
  size: { w: number; h: number },
  tmp: string,
  signal: AbortSignal
): Promise<string> {
  const { clip } = seg
  const out = `seg_${String(index).padStart(3, '0')}.mp4`
  const len = seg.own + seg.overlap + seg.pad
  const frames = Math.max(1, Math.round(len * opts.fps))
  const video = assetOf(bundle, sceneVideoId(clip))
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(opts.fps)]
  if (video) {
    const cam = cameraPerspective(clip.videoCamera, clip.videoStrength, Math.max(2, Math.round(seg.own * opts.fps)), opts.fps)
    const work = cam ? workSize(video.width, video.height, size) : size
    const vf = cameraChain(cam, work, size, [`fps=${opts.fps}`, `tpad=stop_mode=clone:stop_duration=${len.toFixed(3)}`])
    // A video trimmed on the timeline starts that far into its file.
    const from = clip.mediaInMs > 0 ? ['-ss', (clip.mediaInMs / 1000).toFixed(3)] : []
    await runFfmpeg([...from, '-i', assetAbsPath(bundle.project.id, video.localPath), '-vf', vf, '-t', len.toFixed(3), ...enc, out], tmp, signal)
    return out
  }
  const image = assetOf(bundle, sceneImageId(clip))
  if (!image) throw new Error(`Klip ${String(index + 1).padStart(2, '0')} (“${clip.title}”) belum punya gambar.`)
  const ownFrames = Math.max(2, Math.round(seg.own * opts.fps))
  const cam = cameraPerspective(clip.cameraPreset, clip.motionStrength, ownFrames, opts.fps)
  const vf = cameraChain(cam, cam ? workSize(image.width, image.height, size) : size, size, [], sceneImageFit(clip))
  await runFfmpeg(
    [
      ...(clip.importedImageAssetId ? [] : ['-loop', '1', '-framerate', String(opts.fps), '-t', len.toFixed(3)]),
      '-i',
      assetAbsPath(bundle.project.id, image.localPath),
      '-vf',
      clip.importedImageAssetId ? `loop=loop=-1:size=1:start=0,setpts=N/(${opts.fps}*TB),fps=${opts.fps},${vf}` : vf,
      '-frames:v',
      String(frames),
      ...enc,
      out
    ],
    tmp,
    signal
  )
  return out
}

async function renderProject(ctx: TaskCtx, projectId: string, opts: ExportOptions): Promise<string> {
  const mix = await prepareAudioMix(projectId, ctx.signal, (p, m) => ctx.progress(p * 0.04, m))
  const bundle = getBundle(projectId)
  if (!bundle.clips.length) throw new Error('Proyek belum punya klip')
  const size = outputSize(bundle.project.aspectRatio, opts.resolution)
  const tmp = join(dataDir(), 'tmp', `export-${ctx.jobId}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const segs = planSegments(bundle.clips, opts.fps)
    const total = segs.reduce((n, s) => n + s.own, 0)

    // 1. one silent video segment per clip, two at a time
    const files: string[] = new Array(segs.length)
    let done = 0
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < segs.length) {
        const i = next++
        files[i] = await renderSegment(bundle, segs[i], i, opts, size, tmp, ctx.signal)
        done++
        ctx.progress(0.03 + 0.6 * (done / segs.length), `Merender klip ${done} dari ${segs.length}`)
      }
    }
    await Promise.all([worker(), worker()])

    // A single 54-input xfade graph exhausted a shared 8 GB host. Merge at most eight
    // inputs per pass, keeping the final clip's overlap/padding for the next boundary.
    let videoParts: VideoPart[] = segs.map((seg, i) => ({ ...seg, file: files[i] }))
    let level = 0
    while (videoParts.length > 8) {
      const groups = videoGroups(videoParts)
      const combined: VideoPart[] = []
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]
        const last = group[group.length - 1]
        const own = group.reduce((sum, part) => sum + part.own, 0)
        const file = `group_${level}_${i}.mp4`
        const joinGraph = videoJoinGraph(group)
        await runFfmpeg([
          ...group.flatMap((part) => ['-threads', '1', '-i', part.file]),
          '-filter_complex', joinGraph.filters.length ? joinGraph.filters.join(';') : '[0:v]null[joined]',
          '-map', joinGraph.filters.length ? joinGraph.output : '[joined]',
          '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '17',
          '-pix_fmt', 'yuv420p', '-r', String(opts.fps), '-t', (own + last.overlap + last.pad).toFixed(6), file
        ], tmp, ctx.signal)
        combined.push({ file, start: group[0].start, own, overlap: last.overlap, pad: last.pad, transition: last.transition })
        ctx.progress(0.63 + 0.1 * ((i + 1) / groups.length), `Menggabungkan bagian video ${i + 1} dari ${groups.length}`)
      }
      videoParts = combined
      level++
    }

    // 2. captions
    const style = resolveCaption(bundle.project.editor)
    // Captions follow each clip's voice as trimmed and placed on the timeline.
    const chunks = timelineChunks(
      segs.map((s) => {
        const audio = assetOf(bundle, s.clip.audioAssetId)
        if (!audio) return { start: s.start, words: [] }
        const shown = clipCaptionWords(s.clip, audio.meta.words ?? [], audio.durationMs ?? UNKNOWN_AUDIO_MS)
        return { start: s.start, words: shown.words, key: audio.id, offset: shown.offset }
      })
    )
    const burn = opts.burnCaptions && !!style && chunks.length > 0
    // Overlays are part of the picture, so they are drawn even when captions are left out.
    const overlays = bundle.project.editor.overlays ?? []
    const texts = overlays.filter((o): o is TextOverlay => o.kind === 'text' && !!o.text.trim() && o.start < total)
    const images = overlays
      .filter((o): o is ImageOverlay => o.kind === 'image' && o.start < total)
      .map((o) => ({ o, asset: assetOf(bundle, o.assetId) }))
      .filter((x): x is { o: ImageOverlay; asset: Asset } => !!x.asset && existsSync(assetAbsPath(projectId, x.asset.localPath)))
    const useAss = burn || texts.length > 0
    if (useAss) {
      const captions = burn
        ? {
            chunks,
            style: style!,
            pos: bundle.project.editor.captionPosition,
            sizeScale: captionScaleOf(bundle.project.editor)
          }
        : null
      writeFileSync(join(tmp, 'captions.ass'), buildAss(captions, texts, total, size.w, size.h), 'utf8')
      mkdirSync(join(tmp, 'fonts'), { recursive: true })
      for (const f of readdirSync(fontsDir()).filter((x) => x.endsWith('.ttf'))) copyFileSync(join(fontsDir(), f), join(tmp, 'fonts', f))
    }

    // 3. one ffmpeg pass: transitions + captions + audio mix
    const args: string[] = []
    // Bound decoder frame pools when a long story opens dozens of video inputs.
    videoParts.forEach((part) => args.push('-threads', '1', '-i', part.file))
    const joined = videoJoinGraph(videoParts)
    const graph = joined.filters
    let v = joined.output
    // Logos and watermarks sit on the picture, under captions and overlay text.
    images.forEach(({ o, asset }, k) => {
      args.push('-i', assetAbsPath(projectId, asset.localPath))
      const iw = Math.max(2, Math.round((o.width * size.w) / 2) * 2)
      const ih = Math.max(2, Math.round((iw * (asset.height || iw)) / (asset.width || iw) / 2) * 2)
      const { ax, ay } = anchorOffset(o.anchor)
      const x = Math.round(o.x * size.w - ax * iw)
      const y = Math.round(o.y * size.h - ay * ih)
      const end = overlayEnd(o, total)
      graph.push(`[${videoParts.length + k}:v]format=rgba,scale=${iw}:${ih},colorchannelmixer=aa=${o.opacity.toFixed(2)}[ov${k}]`)
      graph.push(`${v}[ov${k}]overlay=x=${x}:y=${y}:enable='between(t,${o.start.toFixed(3)},${end.toFixed(3)})'[vo${k}]`)
      v = `[vo${k}]`
    })
    graph.push(`${v}${useAss ? 'ass=captions.ass:fontsdir=fonts,' : ''}format=yuv420p[vout]`)

    args.push('-i', assetAbsPath(projectId, mix.localPath))
    graph.push(`[${videoParts.length + images.length}:a]apad,atrim=0:${total.toFixed(3)}[aout]`)
    writeFileSync(join(tmp, 'graph.txt'), graph.join(';\n'), 'utf8')

    // ffmpeg runs with cwd = tmp, so a relative folder would be created inside the temp dir
    // and then fail with "No such file or directory". Always resolve it to an absolute path.
    const folder = isAbsolute(opts.folder) ? opts.folder : join(dataDir(), opts.folder)
    mkdirSync(folder, { recursive: true })
    const base = (opts.fileName.trim() || 'video').replace(/[<>:"/\\|?*]+/g, '-').replace(/\.mp4$/i, '')
    let outPath = join(folder, `${base}.mp4`)
    for (let n = 2; existsSync(outPath); n++) outPath = join(folder, `${base}-${n}.mp4`)

    ctx.progress(0.74, 'Menggabungkan klip, suara, dan caption')
    await runFfmpeg(
      [
        ...args,
        '-filter_complex_script',
        'graph.txt',
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-preset',
        'medium',
        '-crf',
        opts.resolution === 2160 ? '20' : '19',
        '-r',
        String(opts.fps),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        '-t',
        total.toFixed(3),
        outPath
      ],
      tmp,
      ctx.signal,
      total,
      (f) => ctx.progress(0.74 + 0.24 * f, 'Menggabungkan klip, suara, dan caption')
    )
    if (audioInputHash(getBundle(projectId)) !== mix.meta.inputHash) throw new Error('Audio berubah selama ekspor. Hasil lama tidak diterapkan; ekspor ulang.')
    if (opts.writeSrt && chunks.length) writeFileSync(outPath.replace(/\.mp4$/i, '.srt'), buildSrt(chunks), 'utf8')
    return outPath
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function startExport(projectId: string, opts: ExportOptions): Job {
  updateEditorSettings(projectId, { normalizeAudio: opts.normalizeAudio, duckMusic: opts.duckMusic })
  const characterSnapshot = assertCharacterConsistency(projectId)
  const job = insertJob({ projectId, kind: 'export', provider: 'ffmpeg', payload: { ...opts, characterSnapshot } })
  emit.job(job)
  return runJob(job, 'export', async (ctx) => {
    const out = await renderProject(ctx, projectId, opts)
    if (assertCharacterConsistency(projectId) !== characterSnapshot) throw new Error('Gambar atau referensi berubah selama export. File lama dipertahankan, tetapi belum disetujui untuk publikasi.')
    touchProject(projectId, { status: 'exported' })
    return { message: out }
  })
}
