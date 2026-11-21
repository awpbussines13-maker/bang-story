import { z } from 'zod'

export function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase()
    const candidate = host === 'youtu.be' ? url.pathname.split('/')[1]
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)
        ? url.searchParams.get('v') || (/^\/(?:shorts|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : null) : null
    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null
  } catch { return null }
}

export function youtubeChannelUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null
    const match = /^\/(@[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+)(?:\/(?:videos|featured))?\/?$/.exec(url.pathname)
    return match ? 'https://www.youtube.com/' + match[1] + '/videos' : null
  } catch { return null }
}

const id = z.string().uuid()
const text = (max: number) => z.string().trim().max(max)
export const imageDataSchema = z.string().max(8 * 1024 * 1024).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/, 'Gunakan gambar PNG, JPEG, atau WebP, maksimal 6 MB.')
const thumbnailUrl = text(8 * 1024 * 1024).refine((v) => {
  if (!v || imageDataSchema.safeParse(v).success) return true
  try { const u = new URL(v); return u.protocol === 'https:' && ['i.ytimg.com', 'img.youtube.com'].includes(u.hostname) } catch { return false }
}, 'Gunakan thumbnail YouTube atau unggah file gambar.')

export const workspaceInputSchema = z.object({
  id: id.optional(), name: text(150).min(1), channelUrl: text(500).refine((v) => !v || !!youtubeChannelUrl(v), 'Masukkan URL channel YouTube.').optional(),
  language: z.enum(['en', 'id']).optional(), notes: text(12000).optional()
})
export const referenceInputSchema = z.object({
  id: id.optional(), workspaceId: id, title: text(300).min(1), url: text(500).refine((v) => !v || !!youtubeVideoId(v), 'Masukkan URL video YouTube.').optional(),
  thumbnailUrl: thumbnailUrl.optional(), description: text(20000).optional(), transcript: text(160000).optional(), videoAnalysis: text(60000).optional(),
  transcriptStatus: z.enum(['missing', 'provided', 'fetched']).optional(), notes: text(12000).optional(),
  viewCount: z.number().int().min(0).nullable().optional(), publishedAt: text(100).optional()
})
export const skillInputSchema = z.object({
  workspaceId: id, name: text(200).min(1), instructions: text(60000).min(30), analysis: text(60000).optional(), sourceIds: z.array(id).max(40).optional()
})
export const productionInputSchema = z.object({
  channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/).optional(),
  workspaceId: id, synopsis: text(20000).min(10), durationSec: z.number().int().min(30).max(1800).optional(),
  language: z.enum(['en', 'id']).optional(), skillId: id.optional(), idempotencyKey: text(200).min(1)
})
export const packagePatchSchema = z.object({
  selectedTitle: text(100).min(1).optional(), description: text(5000).optional(), thumbnailPrompt: text(10000).min(10).optional(),
  beforeLabel: text(16).optional(), afterLabel: text(16).optional(), referenceIds: z.array(id).max(3).optional()
}).strict()

export const outlineSchema = z.object({
  premise: text(10000).min(1), protagonist: text(5000).min(1), resourceLedger: text(10000).min(1),
  beats: z.array(z.object({ day: text(100), event: text(5000), choice: text(5000), cost: text(5000), payoff: text(5000) })).min(5).max(14),
  endingPayoff: text(10000).min(1), innovation: text(5000).min(1)
})
export const packageContentSchema = z.object({
  titleOptions: z.array(z.object({ title: text(100).min(1), angle: text(2000).min(1) })).min(3).max(6),
  description: text(5000), thumbnailPrompt: text(10000).min(20), beforeLabel: text(16), afterLabel: text(16)
})
export const publishingInputSchema = packageContentSchema.extend({ selectedTitle: text(100).min(1), referenceIds: z.array(id).max(3) })

export const editorialRevisionSchema = z.object({
  projectId: id, expectedScriptHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: text(200).min(1),
  outline: outlineSchema,
  scenes: z.array(z.object({ clipId: id, title: text(200).min(1), story: text(5000).min(1), narration: text(20000).min(1) })).min(1).max(500),
  package: publishingInputSchema
}).strict()
