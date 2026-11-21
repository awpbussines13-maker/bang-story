import { sceneImageId, sceneVideoId } from '@shared/flowV2'
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { timelineChunks, type CaptionChunk } from '@shared/captions'
import { transitionSecOf } from '@shared/motion'
import { soundPlanKey } from '@shared/soundDesign'
import { clipCaptionWords, voiceSpan } from '@shared/timeline'
import type { Asset, Clip, Overlay, SfxCue, TransitionId } from '@shared/types'
import { useProject } from '../../../store/project'
import { errorText } from '../../../lib/format'
import { waitForStudioJob } from '../../../lib/audioJobs'

export interface TimelineItem {
  clip: Clip
  index: number
  start: number
  end: number
  image: Asset | null
  video: Asset | null
  audio: Asset | null
}

interface PlaybackState {
  t: number
  playing: boolean
  audioReady: boolean
  seek(t: number): void
  play(): void
  pause(): void
  toggle(): void
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  t: 0,
  playing: false,
  audioReady: false,
  seek: (t) => set({ t: Math.max(0, t) }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set({ playing: !get().playing })
}))

/** Which overlay the Overlay panel, the preview and the timeline have selected. */
export const useOverlayUi = create<{ selectedId: string | null; select(id: string | null): void }>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id })
}))

export const useSfxUi = create<{ selectedId: string | null; select(id: string | null): void }>(set => ({ selectedId: null, select: selectedId => set({ selectedId }) }))

export function updateSfxCue(id: string, patch: Partial<SfxCue>): void {
  const state = useProject.getState(), sound = state.project?.editor.soundDesign
  if (sound) state.updateEditor({ soundDesign: { ...sound, cues: sound.cues.map(c => c.id === id ? { ...c, ...patch, manual: true } : c) } })
}

export function removeSfxCue(id: string): void {
  const state = useProject.getState(), sound = state.project?.editor.soundDesign
  if (sound) state.updateEditor({ soundDesign: { ...sound, cues: sound.cues.filter(c => c.id !== id) } })
  if (useSfxUi.getState().selectedId === id) useSfxUi.getState().select(null)
}

/**
 * A part of the timeline played in the preview only, on a loop, while a setting is being chosen: one clip
 * (camera move) or the joint after a clip (transition, optionally trying another type). The playhead and
 * the audio stay where they are.
 */
export type Audition =
  | { kind: 'clip'; clipId: string }
  | { kind: 'transition'; clipId: string; override?: { transition: TransitionId } }

export const useAudition = create<{
  audition: (Audition & { startedAt: number }) | null
  start(a: Audition): void
  stop(): void
}>((set, get) => ({
  audition: null,
  start: (a) => set({ audition: { ...a, startedAt: performance.now() } }),
  stop: () => {
    if (get().audition) set({ audition: null })
  }
}))

/** The stretch of timeline an audition loops over: the whole clip, or the joint with a little before and after. */
export function auditionWindow(a: Audition, items: TimelineItem[]): { from: number; to: number } | null {
  const i = items.findIndex((it) => it.clip.id === a.clipId)
  if (i < 0) return null
  const it = items[i]
  if (a.kind === 'clip') return { from: it.start, to: it.end }
  const next = items[i + 1]
  if (!next) return null
  const clip = a.kind === 'transition' && a.override ? { ...it.clip, ...a.override } : it.clip
  const sec = Math.min(transitionSecOf(clip), it.end - it.start, next.end - next.start)
  return { from: Math.max(it.start, next.start - 0.8), to: Math.min(next.end, next.start + sec + 0.8) }
}

/** The caption chunk picked on the timeline for editing: its voice asset and first word. */
export const useCaptionUi = create<{ selected: { key: string; from: number } | null; select(s: { key: string; from: number } | null): void }>(
  (set) => ({
    selected: null,
    select: (s) => set({ selected: s })
  })
)

// Overlay edits read the store at call time, so rapid drags never work from a stale list.
const overlaysNow = (): Overlay[] => useProject.getState().project?.editor.overlays ?? []

export function addOverlay(o: Overlay): void {
  useProject.getState().updateEditor({ overlays: [...overlaysNow(), o] })
  useOverlayUi.getState().select(o.id)
}

export function updateOverlay(id: string, patch: Partial<Overlay>): void {
  useProject.getState().updateEditor({ overlays: overlaysNow().map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) })
}

export function removeOverlay(id: string): void {
  useProject.getState().updateEditor({ overlays: overlaysNow().filter((o) => o.id !== id) })
  if (useOverlayUi.getState().selectedId === id) useOverlayUi.getState().select(null)
}

export function useTimeline(): { items: TimelineItem[]; total: number; chunks: CaptionChunk[] } {
  const clips = useProject((s) => s.clips)
  const assets = useProject((s) => s.assets)
  return useMemo(() => {
    let acc = 0
    const items = clips.map((clip, index) => {
      const start = acc
      acc += clip.durationMs / 1000
      const imageId = sceneImageId(clip), videoId = sceneVideoId(clip)
      return {
        clip,
        index,
        start,
        end: acc,
        image: imageId ? (assets[imageId] ?? null) : null,
        video: videoId ? (assets[videoId] ?? null) : null,
        audio: clip.audioAssetId ? (assets[clip.audioAssetId] ?? null) : null
      }
    })
    // Captions follow each clip's voice as trimmed and placed on the timeline (as in the export).
    const chunks = timelineChunks(
      items.map((it) => {
        if (!it.audio) return { start: it.start, words: [] }
        const shown = clipCaptionWords(it.clip, it.audio.meta.words ?? [], it.audio.durationMs ?? UNKNOWN_AUDIO_MS)
        return { start: it.start, words: shown.words, key: it.audio.id, offset: shown.offset }
      })
    )
    return { items, total: acc, chunks }
  }, [clips, assets])
}

/** An audio length to assume when an older asset never recorded its duration. */
export const UNKNOWN_AUDIO_MS = 10 * 60 * 1000

/** Where a clip's voice plays on the timeline, in seconds, and where in its file it starts. */
export function voiceWindow(it: TimelineItem): { from: number; to: number; inSec: number } | null {
  if (!it.audio) return null
  const span = voiceSpan(it.clip, it.audio.durationMs ?? UNKNOWN_AUDIO_MS)
  const from = it.start + span.startMs / 1000
  return { from, to: from + span.playMs / 1000, inSec: span.inMs / 1000 }
}

export function itemAt(items: TimelineItem[], t: number): number {
  if (!items.length) return -1
  const i = items.findIndex((it) => t >= it.start && t < it.end)
  return i === -1 ? items.length - 1 : i
}

/** Preview plays the exact cached mix used by FFmpeg export. */
export function usePlaybackEngine(items: TimelineItem[], total: number): { preparing: boolean; error: string | null } {
  const project = useProject(s => s.project)
  const assets = useProject(s => s.assets)
  const [status, setStatus] = useState<{ preparing: boolean; error: string | null }>({ preparing: false, error: null })
  const audio = useRef<HTMLAudioElement | null>(null)
  const key = JSON.stringify([project?.id, soundPlanKey(items.map(it => it.clip), Object.values(assets)), items.map(it => [it.clip.id, it.clip.durationMs, it.clip.audioAssetId, it.clip.voiceInMs, it.clip.voiceOutMs, it.clip.voiceStartMs, it.clip.voiceGainDb]),
    project?.editor.soundDesign, project?.editor.musicAssetId, project?.editor.musicVolumeDb, project?.editor.musicStartMs,
    project?.editor.musicEndMs, project?.editor.musicInMs, project?.editor.voiceVolumeDb, project?.editor.duckMusic, project?.editor.normalizeAudio,
    Object.values(assets).filter(a => a.kind === 'audio' || a.kind === 'music' || a.kind === 'sfx').map(a => [a.id, a.localPath, a.durationMs, a.meta])])
  useEffect(() => {
    let disposed = false
    audio.current?.pause(); audio.current = null
    usePlayback.setState({ audioReady: false })
    setStatus({ preparing: true, error: null })
    const timer = setTimeout(() => { void (async () => {
      try {
        const state = useProject.getState()
        await state.flush()
        if (disposed) return
        if (useProject.getState().saveState === 'error') throw new Error(useProject.getState().saveError ?? 'Proyek gagal disimpan')
        const { bundle, job } = await waitForStudioJob(project!.id, () => window.api.audio.prepare(project!.id, crypto.randomUUID()), () => disposed)
        if (disposed) return
        const asset = bundle.assets.find(a => a.id === job?.resultAssetId)
        if (!asset) throw new Error('Mix audio tidak ditemukan')
        const el = new Audio(asset.url)
        el.preload = 'auto'
        audio.current = el
        usePlayback.setState({ audioReady: true })
        el.onerror = () => { usePlayback.getState().pause(); setStatus({ preparing: false, error: 'Mix audio gagal dimuat' }) }
        setStatus({ preparing: false, error: null })
      } catch (e) {
        if (!disposed) { usePlayback.getState().pause(); setStatus({ preparing: false, error: errorText(e) }) }
      }
    })() }, 450)
    return () => { disposed = true; clearTimeout(timer); audio.current?.pause(); audio.current = null }
  }, [key])

  useEffect(() => {
    let frame = 0, pending = false, disposed = false
    const tick = (): void => {
      const state = usePlayback.getState(), el = audio.current
      if (el) {
        if (state.t >= total && state.playing) { usePlayback.setState({ playing: false }) }
        else if (el.ended && state.playing) { usePlayback.setState({ t: total, playing: false }) }
        else if (!state.playing) { el.pause(); if (Math.abs(el.currentTime-state.t) > .02) el.currentTime=state.t }
        else if (el.paused && !pending) {
          el.currentTime = state.t
          pending = true
          void el.play().then(() => { if (disposed || !usePlayback.getState().playing) el.pause() }).catch(e => {
            if (!disposed) { usePlayback.getState().pause(); setStatus({ preparing: false, error: errorText(e) }) }
          }).finally(() => { pending = false })
        } else if (!pending) {
          if (Math.abs(el.currentTime-state.t) > .3) el.currentTime=state.t
          usePlayback.setState({ t: Math.min(total, el.currentTime), playing: !el.ended && el.currentTime < total })
        }
      }
      frame = requestAnimationFrame(tick)
    }
    const unsubscribe = usePlayback.subscribe((s,p) => {
      if (!audio.current) return
      if (!s.playing) audio.current.pause()
      if (Math.abs(s.t-p.t) > .15) audio.current.currentTime = s.t
    })
    frame = requestAnimationFrame(tick)
    return () => { disposed = true; cancelAnimationFrame(frame); unsubscribe(); audio.current?.pause() }
  }, [total])
  useEffect(() => () => usePlayback.setState({ playing: false }), [])
  return status
}
