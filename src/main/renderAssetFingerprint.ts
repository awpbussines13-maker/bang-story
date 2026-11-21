import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import type { Asset } from '@shared/types'

// Stream large audio/video inputs so checking an export never allocates the entire file.
export function renderAssetFingerprint(asset: Asset, absolutePath: string): unknown[] {
  let fd: number | undefined
  let content: string
  try {
    fd = openSync(absolutePath, 'r')
    const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024)
    let count: number
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) digest.update(chunk.subarray(0, count))
    content = digest.digest('hex')
  } catch {
    content = 'unavailable'
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return [asset.id, asset.kind, content, asset.durationMs, asset.width, asset.height, asset.meta.words ?? null]
}
