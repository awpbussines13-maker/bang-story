import { youtubeChannelUrl, youtubeVideoId } from '@shared/atmSchema'
import { getAtmWorkspace, listAtmReferences, saveAtmReference } from './atmRepo'
import type { AtmReference } from '@shared/atm'

async function publicText(url: string, maxBytes = 2500000): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' } })
  if (!response.ok) throw new Error('YouTube belum bisa diakses (HTTP ' + response.status + '). Tambahkan judul dan transkrip secara manual.')
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('Data referensi terlalu besar.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('YouTube tidak mengirim data.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error('Data referensi terlalu besar.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks).toString('utf8')
}

export function assignedYoutubeObject(html: string, name: string): Record<string, any> | null {
  const start = html.indexOf(name)
  if (start < 0) return null
  const brace = html.indexOf('{', start + name.length)
  if (brace < 0 || brace - start > 100) return null
  let depth = 0, quoted = false, escaped = false
  for (let i = brace; i < html.length; i++) {
    const c = html[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(brace, i + 1)) } catch { return null }
    }
  }
  return null
}

export async function importAtmReference(workspaceId: string, url: string): Promise<AtmReference> {
  getAtmWorkspace(workspaceId)
  const videoId = youtubeVideoId(url)
  if (!videoId) throw new Error('Tempel URL satu video YouTube, atau gunakan tombol Impor channel.')
  const canonical = 'https://www.youtube.com/watch?v=' + videoId
  const existing = listAtmReferences(workspaceId).find((r) => youtubeVideoId(r.url) === videoId)
  let title = existing?.title || ''
  let description = existing?.description || ''
  let transcript = existing?.transcript || ''
  let transcriptStatus = existing?.transcriptStatus || 'missing'
  let viewCount = existing?.viewCount ?? null
  let publishedAt = existing?.publishedAt || ''
  const notes: string[] = []
  try {
    const oembed = JSON.parse(await publicText('https://www.youtube.com/oembed?url=' + encodeURIComponent(canonical) + '&format=json', 20000))
    title = oembed.title || title
  } catch { notes.push('Metadata oEmbed tidak tersedia.') }
  try {
    const html = await publicText(canonical)
    const player = assignedYoutubeObject(html, 'ytInitialPlayerResponse')
    title = player?.videoDetails?.title || title
    description = player?.videoDetails?.shortDescription || description
    const views = Number(player?.videoDetails?.viewCount)
    if (Number.isFinite(views) && views > 0) viewCount = views
    publishedAt = player?.microformat?.playerMicroformatRenderer?.publishDate || publishedAt
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    const track = tracks.find((t: any) => t.languageCode === 'en') ?? tracks[0]
    if (!transcript && track?.baseUrl) {
      const caption = new URL(track.baseUrl)
      if (['www.youtube.com', 'youtube.com'].includes(caption.hostname) && caption.pathname === '/api/timedtext' && caption.protocol === 'https:') {
        caption.searchParams.set('fmt', 'json3')
        const data = JSON.parse(await publicText(caption.href, 1500000))
        transcript = (data.events ?? []).map((e: any) => (e.segs ?? []).map((s: any) => s.utf8 || '').join('')).filter(Boolean).join('\n')
        if (transcript.trim()) transcriptStatus = 'fetched'
      }
    }
  } catch { notes.push('Caption belum berhasil diambil otomatis.') }
  if (!title) throw new Error('Metadata video belum tersedia. Tambahkan referensi manual dengan judul dan transkrip.')
  if (!transcript) notes.push('Transkrip belum tersedia; analisis cerita penuh memerlukan transkrip.')
  return saveAtmReference({
    id: existing?.id, workspaceId, url: canonical, title, description, transcript, transcriptStatus, viewCount, publishedAt,
    thumbnailUrl: existing?.thumbnailUrl || 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
    notes: [existing?.notes, ...notes].filter(Boolean).join('\n')
  })
}

export async function importAtmChannel(workspaceId: string): Promise<{ imported: number; warnings: string[] }> {
  const workspace = getAtmWorkspace(workspaceId)
  const url = youtubeChannelUrl(workspace.channelUrl)
  if (!url) throw new Error('Isi URL channel di pengaturan ruang ATM dulu.')
  const html = await publicText(url, 5000000)
  const cards = youtubeChannelVideos(html)
  const popular = [...cards].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
  const selection = [...new Map([...cards.slice(0, 4), ...popular.slice(0, 4), ...cards].map((v) => [v.id, v])).values()].slice(0, 8)
  if (!selection.length) throw new Error('Daftar video dibatasi YouTube. Tambahkan URL video atau referensi manual.')
  let imported = 0
  const warnings: string[] = []
  for (let offset = 0; offset < selection.length; offset += 3) {
    const results = await Promise.allSettled(selection.slice(offset, offset + 3).map(async (card) => {
      const videoUrl = 'https://www.youtube.com/watch?v=' + card.id
      const existing = listAtmReferences(workspaceId).find((r) => youtubeVideoId(r.url) === card.id)
      if (!existing) saveAtmReference({ workspaceId, url: videoUrl, title: card.title, thumbnailUrl: 'https://i.ytimg.com/vi/' + card.id + '/hqdefault.jpg', viewCount: card.viewCount, notes: 'Public channel card snapshot. Counts may be rounded. ' + card.publishedLabel })
      return importAtmReference(workspaceId, videoUrl)
    }))
    for (const r of results) {
      if (r.status === 'fulfilled') imported++
      else warnings.push(r.reason instanceof Error ? r.reason.message : 'Satu video gagal diimpor.')
    }
  }
  return { imported, warnings }
}

export function youtubeChannelVideos(html: string): { id: string; title: string; viewCount: number | null; publishedLabel: string }[] {
  const data = assignedYoutubeObject(html, 'ytInitialData')
  const cards = new Map<string, { id: string; title: string; viewCount: number | null; publishedLabel: string }>()
  const label = (v: any) => typeof v?.simpleText === 'string' ? v.simpleText : (v?.runs ?? []).map((r: any) => r.text || '').join('')
  const walk = (value: any): void => {
    if (!value || typeof value !== 'object') return
    const card = value.videoRenderer || value.gridVideoRenderer
    if (card && /^[A-Za-z0-9_-]{11}$/.test(card.videoId || '')) {
      const title = label(card.title)
      const text = label(card.viewCountText)
      const number = Number(text.replace(/[^0-9]/g, ''))
      if (title && !cards.has(card.videoId)) cards.set(card.videoId, { id: card.videoId, title, viewCount: /^\d[\d,\s]* views?$/.test(text) && Number.isSafeInteger(number) ? number : null, publishedLabel: label(card.publishedTimeText) })
    }
    for (const item of Object.values(value)) walk(item)
  }
  walk(data)
  return [...cards.values()]
}
