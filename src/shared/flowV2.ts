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
  images: { name: string; thumbnail: string }[]
  scenes: { id: string; title: string; image: string | null }[]
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

export function sceneImageId(clip: Pick<Clip, 'importedImageAssetId' | 'imageAssetId'>): string | null {
  return clip.importedImageAssetId ?? clip.imageAssetId
}

export function sceneVideoId(clip: Pick<Clip, 'importedImageAssetId' | 'motionType' | 'videoAssetId'>): string | null {
  return !clip.importedImageAssetId && clip.motionType === 'video' ? clip.videoAssetId : null
}

export function sceneImageFit(clip: Pick<Clip, 'importedImageAssetId' | 'imageFit'>): ImageFit {
  return clip.importedImageAssetId ? clip.imageFit : 'cover'
}

export function makeReferencePrompt(name: string, description: string): string {
  const appearance = description.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  return appearance ? `Character reference sheet for ${name.trim() || 'this character'}. ${appearance}. Show consistent proportions, clothing and colors in front, three-quarter and side views. Use a plain background and even lighting.` : ''
}
