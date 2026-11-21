import type { Asset } from '@shared/types'

/** An asset ID and a still-live remote URL do not prove that the file still has the same pixels. */
export function cachedReferenceUrl(asset: Pick<Asset, 'provider' | 'remoteUrl' | 'createdAt' | 'meta'>, fileHash: string, now: number): string | null {
  if (asset.remoteUrl && asset.provider === 'higgsfield' && asset.meta.remoteFileHash === fileHash && now - asset.createdAt < 6 * 86400000) return asset.remoteUrl
  if (typeof asset.meta.uploadedUrl === 'string' && typeof asset.meta.uploadedAt === 'number' && asset.meta.uploadedHash === fileHash && now - asset.meta.uploadedAt < 0.5 * 86400000) return asset.meta.uploadedUrl
  return null
}
