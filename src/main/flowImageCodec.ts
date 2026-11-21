import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { FLOW_IMAGE_LIMIT } from '@shared/flowV2'
import { binPath } from './paths'

export function imageExtension(bytes: Buffer): 'png' | 'jpg' | 'webp' {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png'
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp'
  throw new Error('Pilih gambar JPG, PNG, atau WebP yang valid.')
}

/** Decode only a bounded still frame and force a pipe input format so no external resources are opened. */
export function decodeFlowImage(bytes: Buffer, mode: 'thumbnail' | 'webp'): Promise<{ output: Buffer; width: number; height: number }> {
  const ext = imageExtension(bytes)
  if (bytes.length > FLOW_IMAGE_LIMIT) throw new Error('Ukuran gambar maksimal 10 MB.')
  if (!ffmpegStatic) throw new Error('FFmpeg tidak ditemukan di aplikasi.')
  const thumbnail = mode === 'thumbnail'
  return new Promise((resolve, reject) => {
    const child = spawn(binPath(ffmpegStatic!), [
      '-hide_banner', '-v', 'info', '-xerror', '-threads', '1', '-filter_threads', '1', '-max_pixels', '50000000',
      '-f', (ext === 'jpg' ? 'jpeg' : ext) + '_pipe', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', thumbnail ? 'scale=128:128:force_original_aspect_ratio=decrease' : "scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease",
      '-an', '-c:v', thumbnail ? 'mjpeg' : 'libwebp', ...(thumbnail ? [] : ['-quality', '90']), '-threads', '1', '-f', 'image2pipe', 'pipe:1'
    ], { windowsHide: true, timeout: 15000 })
    let log = ''
    let size = 0
    const chunks: Buffer[] = []
    child.stderr.on('data', (chunk) => { log = (log + chunk).slice(0, 8192) })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > FLOW_IMAGE_LIMIT) child.kill()
      else chunks.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      const dims = /Video:.*?,\s*(\d{1,5})x(\d{1,5})(?:\s|,)/.exec(log.slice(log.indexOf('Output #')))
      if (code !== 0 || !dims || !size || size > FLOW_IMAGE_LIMIT) {
        reject(new Error('Gambar gagal dibaca atau resolusinya terlalu besar.'))
        return
      }
      resolve({ output: Buffer.concat(chunks), width: Number(dims[1]), height: Number(dims[2]) })
    })
    child.stdin.end(bytes)
  })
}
