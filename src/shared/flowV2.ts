import { getStyle, STICKMAN_CHARACTER_STYLE } from './styles'
import type { AspectRatio, Asset, Clip, ImageFit } from './types'

export const FLOW_IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp'
export const FLOW_IMAGE_LIMIT = 10 * 1024 * 1024
export const FLOW_ZIP_LIMIT = 96 * 1024 * 1024

export interface FlowProjectV2 {
  app: 'bang-story'
  formatVersion: 2
  projectTitle: string
  language: string
  aspectRatio: AspectRatio
  visualStyle: string
  characters: { id: string; name: string; description: string; referencePrompt: string; referenceImage: string | null }[]
  scenes: { id: string; title: string; narration: string; visualPrompt: string; characterIds: string[] }[]
}

export interface FlowImportPreview {
  token: string
  images: { name: string; thumbnail: string; clipId: string | null }[]
  scenes: { id: string; label: string }[]
}

export interface FlowImageChange {
  clipId: string
  asset: Asset | null
  imageFit: ImageFit
}

export interface FlowImageApi {
  exportSummary(projectId: string): Promise<string[]>
  exportZip(projectId: string, confirmed: boolean): Promise<void>
  reference(projectId: string, characterId: string, bytes: ArrayBuffer | null): Promise<Asset | null>
  importImage(projectId: string, clipId: string, bytes: ArrayBuffer, fit: ImageFit): Promise<FlowImageChange>
  importUrl(projectId: string, clipId: string, url: string, fit: ImageFit): Promise<FlowImageChange>
  changeImage(projectId: string, clipId: string, fit: ImageFit | null): Promise<FlowImageChange>
  previewZip(projectId: string, bytes: ArrayBuffer): Promise<FlowImportPreview>
  applyZip(projectId: string, token: string, mapping: { clipId: string; image: string }[], fit: ImageFit): Promise<FlowImageChange[]>
}

export function characterFlowIds(characters: { name: string }[]): string[] {
  const used = new Set<string>()
  return characters.map(({ name }) => {
    const base = name.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'pemeran'
    let id = base
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`
    used.add(id)
    return id
  })
}

export function clipFlowId(index: number): string {
  return `klip-${String(index + 1).padStart(2, '0')}`
}

export function flowClipLabel(index: number, title: string): string {
  return `Klip ${clipFlowId(index).slice(5)} — ${title.trim() || 'Tanpa judul'}`
}

export function sceneImageId(clip: Pick<Clip, 'importedImageAssetId' | 'imageAssetId'>): string | null {
  return clip.importedImageAssetId ?? clip.imageAssetId
}

export function sceneVideoId(clip: Pick<Clip, 'importedImageAssetId' | 'motionType' | 'videoAssetId'>): string | null {
  return !clip.importedImageAssetId && clip.motionType === 'video' ? clip.videoAssetId : null
}

export function sceneImageFit(clip: Pick<Clip, 'importedImageAssetId' | 'imageFit'>): ImageFit {
  return clip.importedImageAssetId ? clip.imageFit : 'cover'
}

const REFERENCE_STYLE_PREFIX = 'Project visual style ('

export function withReferenceStyle(prompt: string, styleId: string): string {
  // Replacing the generated paragraph preserves the editable character details across style changes.
  const body = prompt.trim().replace(/^Project visual style \([^\r\n]+\): [^\r\n]*(?:\r?\n|$)/, '').trim()
  if (!body) return ''
  const style = getStyle(styleId)
  const rendering = style.id === 'stickman'
    ? STICKMAN_CHARACTER_STYLE + ' Single style only — do not mix a realistic human version with a stickman version in the same sheet.'
    : `Draw every view as ${style.characterHint}. Single style only — use this rendering style in every view.`
  return `${REFERENCE_STYLE_PREFIX}${style.name}): ${rendering}\n\n${body}`
}

export function makeReferencePrompt(name: string, description: string, styleId: string): string {
  const appearance = description.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  return appearance ? withReferenceStyle(
    `Character reference sheet for ${name.trim() || 'this character'}. ${appearance}. Show the same age, hair, proportions, clothing and colors in front, three-quarter and side views. Use a plain background and even lighting.`,
    styleId
  ) : ''
}
