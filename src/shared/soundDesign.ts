import { z } from 'zod'
import type { Asset, Clip, EditorSettings, SfxCue } from './types'

export const SFX_PRESETS = [
  { value: 'ambience', label: 'Ambience abstrak' },
  { value: 'pulse', label: 'Pulse tegang' },
  { value: 'riser', label: 'Riser' },
  { value: 'impact', label: 'Impact' },
  { value: 'whoosh', label: 'Whoosh' }
] as const

const ms = z.number().int().min(0).max(3_600_000)
export const sfxCueSchema = z.object({
  id: z.string().min(1).max(200), clipId: z.string().min(1).max(200), label: z.string().max(300),
  assetId: z.string().min(1).max(200).nullable(), preset: z.enum(['ambience', 'pulse', 'riser', 'impact', 'whoosh']).nullable(),
  startMs: ms, durationMs: ms.min(1), inMs: ms, sourceDurationMs: ms.min(1).optional(),
  gainDb: z.number().min(-60).max(12), fadeInMs: ms, fadeOutMs: ms,
  muted: z.boolean(), manual: z.boolean(), bed: z.boolean()
}).strict().refine(c => !!c.assetId !== !!c.preset, 'Pilih satu aset atau preset SFX')
export const soundDesignSchema = z.object({
  enabled: z.boolean(), cues: z.array(sfxCueSchema).max(1000),
  planHash: z.string().max(100).optional(), warnings: z.array(z.string().max(500)).max(100).optional()
}).strict()

export function validateSoundDesign(editor: EditorSettings, clips: Pick<Clip, 'id' | 'durationMs'>[], assets: Asset[]): void {
  if (!editor.soundDesign) return
  const sound = soundDesignSchema.parse(editor.soundDesign)
  const ids = new Set<string>()
  for (const cue of sound.cues) {
    if (ids.has(cue.id)) throw new Error('ID cue SFX harus unik')
    ids.add(cue.id)
    const clip = clips.find(c => c.id === cue.clipId)
    if (!clip) throw new Error('Adegan SFX tidak ditemukan di proyek ini')
    if (cue.startMs >= clip.durationMs) throw new Error('Awal SFX melewati akhir adegan')
    if (cue.fadeInMs + cue.fadeOutMs > cue.durationMs) throw new Error('Fade SFX melebihi durasinya')
    if (cue.assetId) {
      const asset = assets.find(a => a.id === cue.assetId && a.kind === 'sfx')
      if (!asset || !asset.durationMs) throw new Error('Aset SFX harus audio milik proyek ini')
      if (cue.inMs + cue.durationMs > asset.durationMs) throw new Error('Potongan SFX melebihi panjang aset')
    } else if (cue.inMs + cue.durationMs > (cue.sourceDurationMs ?? cue.durationMs)) {
      throw new Error('Potongan SFX melebihi panjang preset')
    }
  }
}

/** Clip-local coordinates keep cues attached when scenes are reordered. */
export function sfxSpans(clips: Pick<Clip, 'id' | 'durationMs'>[], editor: EditorSettings): { cue: SfxCue; startMs: number; playMs: number }[] {
  if (!editor.soundDesign?.enabled) return []
  let start = 0
  return clips.flatMap(clip => {
    const base = start
    start += clip.durationMs
    return editor.soundDesign!.cues.filter(c => c.clipId === clip.id && !c.muted).map(cue => ({
      cue, startMs: base + cue.startMs, playMs: Math.max(0, Math.min(cue.durationMs, clip.durationMs - cue.startMs))
    })).filter(s => s.playMs > 0)
  })
}

/** Used by both the browser and backend to detect an obsolete automatic plan. */
export function soundPlanKey(clips: Pick<Clip, 'id' | 'story' | 'narration' | 'visualPrompt' | 'durationMs' | 'audioAssetId' | 'voiceInMs' | 'voiceOutMs' | 'voiceStartMs'>[], assets: Pick<Asset, 'id' | 'meta'>[] = []): string {
  const text = JSON.stringify(clips.map(c => [c.id, c.story, c.narration, c.visualPrompt, c.durationMs, c.audioAssetId, c.voiceInMs, c.voiceOutMs, c.voiceStartMs, assets.find(a => a.id === c.audioAssetId)?.meta.words ?? []]))
  // This is a UI revision marker; media cache fingerprints use SHA-256 and actual source bytes.
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}

export function soundPlanStale(clips: Clip[], editor: EditorSettings, assets: Pick<Asset, 'id' | 'meta'>[] = []): boolean {
  const sound = editor.soundDesign
  return !!(sound?.enabled && sound.planHash && sound.planHash !== soundPlanKey(clips, assets) && (!sound.cues.length || sound.cues.some(c => !c.manual)))
}

export function splitSfxCues(cues: SfxCue[], clipId: string, nextId: string, atMs: number, newId: () => string): SfxCue[] {
  return cues.flatMap(cue => {
    if (cue.clipId !== clipId) return [cue]
    if (cue.startMs >= atMs) return [{ ...cue, clipId: nextId, startMs: cue.startMs - atMs }]
    if (cue.startMs + cue.durationMs <= atMs) return [cue]
    const firstMs = atMs - cue.startMs
    const sourceDurationMs = cue.sourceDurationMs ?? cue.inMs + cue.durationMs
    return [
      { ...cue, sourceDurationMs, durationMs: firstMs, fadeInMs: Math.min(cue.fadeInMs, firstMs), fadeOutMs: 0 },
      { ...cue, sourceDurationMs, id: newId(), clipId: nextId, startMs: 0, inMs: cue.inMs + firstMs,
        durationMs: cue.durationMs - firstMs, fadeInMs: 0, fadeOutMs: Math.min(cue.fadeOutMs, cue.durationMs - firstMs) }
    ]
  })
}
