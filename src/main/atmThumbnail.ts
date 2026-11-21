import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import { GoogleGenAI } from '@google/genai'
import { imageDataSchema } from '@shared/atmSchema'
import { isFluxImageModel, isValidThumbnailModel, supportsNineRouterImageReferences } from '@shared/models'
import { THUMBNAIL_LAYOUT as L, type AtmProductionDetail } from '@shared/atm'
import { getAtmProduction, getAtmProductionDetail, listAtmReferences, saveAtmPackage } from './atmRepo'
import { getAsset, insertAsset, getCharacter } from './repo'
import { assetAbsPath, binPath, fontsDir, projectDir } from './paths'
import { fontMeasure } from './fontMetrics'
import { requireSecret } from './secrets'
import { probeSize } from './services/audio'
import { generateImage as routerImage } from './services/ninerouter'

const run = promisify(execFile)
const busy = new Set<string>()

function imageBytes(dataUrl: string): { bytes: Buffer; mimeType: string } {
  imageDataSchema.parse(dataUrl)
  const split = dataUrl.indexOf(',')
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'))
  const bytes = Buffer.from(dataUrl.slice(split + 1), 'base64')
  const signature = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'
  if (!signature || bytes.length > 6 * 1024 * 1024) throw new Error('Gambar tidak valid atau melebihi 6 MB.')
  return { bytes, mimeType }
}

async function referenceImage(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  if (url.startsWith('data:')) return imageBytes(url)
  const u = new URL(url)
  if (u.protocol !== 'https:' || !['i.ytimg.com','img.youtube.com'].includes(u.hostname)) throw new Error('Sumber gambar referensi tidak didukung.')
  const response = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('Gambar referensi gagal diambil. Unggah thumbnail referensi sebagai file.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Gambar referensi kosong.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 6 * 1024 * 1024) throw new Error('Gambar referensi melebihi 6 MB.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const mime = (response.headers.get('content-type') || '').split(';')[0]
  return imageBytes('data:' + mime + ';base64,' + Buffer.concat(chunks).toString('base64'))
}

async function saveArtwork(projectId: string, dataUrl: string, model = 'uploaded', provider: 'gemini' | '9router' = 'gemini'): Promise<void> {
  const p = getAtmProduction(projectId)
  if (!p?.package) throw new Error('Siapkan judul dan konsep thumbnail dulu.')
  const image = imageBytes(dataUrl)
  const relative = 'thumbnails/' + randomUUID() + (image.mimeType === 'image/jpeg' ? '.jpg' : image.mimeType === 'image/webp' ? '.webp' : '.png')
  const abs = join(projectDir(projectId), relative)
  mkdirSync(join(projectDir(projectId), 'thumbnails'), { recursive: true })
  writeFileSync(abs, image.bytes)
  const dimensions = await probeSize(abs)
  if (!dimensions) { rmSync(abs, { force: true }); throw new Error('File gambar tidak dapat dibaca.') }
  const asset = insertAsset({ projectId, kind: 'overlay', localPath: relative, width: dimensions.width, height: dimensions.height, provider: model === 'uploaded' ? null : provider, model, prompt: p.package.thumbnailPrompt })
  saveAtmPackage(projectId, { ...p.package, artworkAssetId: asset.id, thumbnailAssetId: null })
}

async function normalizeGeneratedArtwork(projectId: string, bytes: Buffer, contentType: string): Promise<string> {
  const mimeType = contentType.split(';')[0].toLowerCase()
  const direct = 'data:' + mimeType + ';base64,' + bytes.toString('base64')
  try {
    imageBytes(direct)
    return direct
  } catch {
    if (!mimeType.startsWith('image/') || !bytes.length || bytes.length > 32 * 1024 * 1024) {
      throw new Error('Model mengirim gambar dengan format atau ukuran yang tidak didukung.')
    }
  }

  const dir = join(projectDir(projectId), 'thumbnails')
  mkdirSync(dir, { recursive: true })
  const source = join(dir, randomUUID() + '.source')
  const output = join(dir, randomUUID() + '.jpg')
  try {
    writeFileSync(source, bytes, { mode: 0o600, flag: 'wx' })
    await run(binPath(ffmpeg!), ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', '-frames:v', '1', '-q:v', '3', output],
    { timeout: 30000, maxBuffer: 1024 * 1024 })
    const normalized = 'data:image/jpeg;base64,' + readFileSync(output).toString('base64')
    imageBytes(normalized)
    return normalized
  } catch {
    throw new Error('Output gambar model tidak bisa dinormalisasi ke JPEG 1280x720.')
  } finally {
    rmSync(source, { force: true })
    rmSync(output, { force: true })
  }
}

async function withThumbnailLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(projectId)) throw new Error('Thumbnail project ini sedang diproses. Tunggu sampai selesai.')
  busy.add(projectId)
  try { return await fn() } finally { busy.delete(projectId) }
}

export async function generateAtmThumbnail(projectId: string, chosenModel?: string, signal?: AbortSignal, provider: 'gemini' | '9router' = 'gemini'): Promise<AtmProductionDetail> {
  return withThumbnailLock(projectId, async () => {
    const p = getAtmProduction(projectId)
    if (!p?.package) throw new Error('Siapkan judul dan konsep thumbnail dulu.')
    const model = chosenModel || (provider === '9router' ? 'cx/gpt-image-2.5' : 'gemini-3.1-flash-image')
    if (!isValidThumbnailModel(model, provider)) throw new Error('Nama model gambar tidak valid.')
    const pack = p.package
    const refs = listAtmReferences(p.workspaceId)
    const selected = pack.referenceIds.map((id) => {
      const ref = refs.find((r) => r.id === id && r.thumbnailUrl)
      if (!ref) throw new Error('Salah satu referensi gambar sudah tidak tersedia. Pilih ulang referensinya.')
      return ref
    })
    const images = await Promise.all(selected.map((r) => referenceImage(r.thumbnailUrl)))
    if (p.identitySnapshot) {
      for (const c of p.identitySnapshot.characters) {
        const sheet = getAsset(getCharacter(c.characterId).sheetAssetId)
        if (!sheet || sheet.projectId !== projectId) throw new Error('Lembar identitas channel tidak tersedia untuk thumbnail.')
        const bytes = readFileSync(assetAbsPath(projectId, sheet.localPath))
        const mimeType = sheet.localPath.endsWith('.webp') ? 'image/webp' : /\.jpe?g$/i.test(sheet.localPath) ? 'image/jpeg' : 'image/png'
        images.push({ bytes, mimeType })
      }
    }
    const prompt = [
      'Create one original 16:9 YouTube thumbnail illustration.',
      p.identitySnapshot ? 'The final supplied images are the original channel cast sheets. Reuse their exact identities, faces and permanent design; earlier images only guide composition.' : '',
      ...(selected.length ? ['The first supplied images guide composition, contrast and clarity.'] : []),
      p.identitySnapshot ? 'Adapt the new story using the final character sheets as identity references. Invent new staging and events for these characters.' : 'Adapt the actual new story below. Invent original character design, staging and details. Do not copy source protagonists, logos or specific scene content.',
      'No letters, numbers, captions, text, labels or watermark in the artwork. Leave the top 22 percent free of important faces for the application-rendered labels.',
      pack.thumbnailPrompt, 'Story brief: ' + p.brief, p.outline ? 'Original protagonist: ' + p.outline.protagonist : ''
    ].join('\n\n')
    const assertCurrent = () => {
      signal?.throwIfAborted()
      const latest = getAtmProduction(projectId)?.package
      if (!latest || latest.thumbnailPrompt !== pack.thumbnailPrompt || JSON.stringify(latest.referenceIds) !== JSON.stringify(pack.referenceIds)) throw new Error('Brief thumbnail berubah saat gambar dibuat. Jalankan lagi dengan brief terbaru.')
    }
    if (provider === '9router') {
      if (images.length && !supportsNineRouterImageReferences(model)) throw new Error('Pilih model 9Router dengan dukungan referensi: cx/ atau FLUX yang didukung. Referensi tidak akan diabaikan.')
      const image = await routerImage(prompt, model, isFluxImageModel(model) ? '1792x1024' : '1536x1024', signal ? AbortSignal.any([signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000), images.map(r => 'data:' + r.mimeType + ';base64,' + r.bytes.toString('base64')))
      assertCurrent()
      await saveArtwork(projectId, await normalizeGeneratedArtwork(projectId, image.bytes, image.contentType), model, provider)
      return renderUnlocked(projectId)
    }
    const ai = new GoogleGenAI({ apiKey: requireSecret('gemini') })
    const response = await ai.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          ...images.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.bytes.toString('base64') } })),
          { text: prompt }
        ]
      }],
      config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' }, abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000) }
    }).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) throw new Error('Kuota model gambar Gemini tidak tersedia. Gunakan kunci yang memiliki kuota atau unggah ilustrasi dari agent.')
      if (/503|UNAVAILABLE|high demand/i.test(message)) throw new Error('Model gambar Gemini sedang sibuk. Hasil sebelumnya tetap tersimpan; kamu juga bisa mengunggah ilustrasi dari agent.')
      throw e
    })
    const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data && !p.thought)
    if (!part?.inlineData?.data) throw new Error('Model tidak mengirim gambar. Pilih model Gemini gambar atau unggah ilustrasi dari agent.')
    assertCurrent()
    await saveArtwork(projectId, await normalizeGeneratedArtwork(projectId, Buffer.from(part.inlineData.data, 'base64'), part.inlineData.mimeType || 'image/png'), model)
    return renderUnlocked(projectId)
  })
}

export async function importAtmArtwork(projectId: string, dataUrl: string): Promise<AtmProductionDetail> {
  return withThumbnailLock(projectId, async () => { await saveArtwork(projectId, dataUrl); return renderUnlocked(projectId) })
}

const filterPath = (value: string): string => value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")

async function renderUnlocked(projectId: string): Promise<AtmProductionDetail> {
  const p = getAtmProduction(projectId)
  if (!p?.package?.artworkAssetId) throw new Error('Buat atau unggah ilustrasi thumbnail dulu.')
  const pack = p.package
  const art = getAsset(pack.artworkAssetId)
  if (!art || art.projectId !== projectId) throw new Error('Ilustrasi thumbnail tidak ditemukan.')
  const dir = join(projectDir(projectId), 'thumbnails')
  mkdirSync(dir, { recursive: true })
  const id = randomUUID()
  const labels = join(dir, id + '-labels.ass')
  const relative = 'thumbnails/' + id + '.jpg'
  const output = assetAbsPath(projectId, relative)
  const fontFile = join(fontsDir(), 'ArchivoBlack-Regular.ttf')
  const measure = fontMeasure(fontFile)
  const fontSize = (text: string) => Math.min(L.fontSize, Math.floor(560 / Math.max(1, measure(text))))
  const assText = (text: string) => text.replace(/\\/g, '\\\\').replace(/[{}\r\n]/g, '')
  const color = '&H00' + L.afterColor.slice(5, 7) + L.afterColor.slice(3, 5) + L.afterColor.slice(1, 3)
  writeFileSync(labels, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + L.width, 'PlayResY: ' + L.height, 'WrapStyle: 2',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Label,Archivo Black,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,7,0,0,0,1',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:05.00,Label,,0,0,0,,{\\an7\\pos(' + L.left + ',' + L.top + ')\\fs' + fontSize(pack.beforeLabel) + '}' + assText(pack.beforeLabel),
    'Dialogue: 0,0:00:00.00,0:00:05.00,Label,,0,0,0,,{\\an7\\pos(' + L.right + ',' + L.top + ')\\fs' + fontSize(pack.afterLabel) + '\\c' + color + '&}' + assText(pack.afterLabel)
  ].join('\n'))
  const filters = [
    'scale=' + L.width + ':' + L.height + ':force_original_aspect_ratio=increase,crop=' + L.width + ':' + L.height,
    'drawbox=x=0:y=0:w=iw:h=' + (L.top + L.labelHeight) + ':color=black@0.6:t=fill',
    "ass='" + filterPath(labels) + "':fontsdir='" + filterPath(fontsDir()) + "'"
  ]
  try {
    await run(binPath(ffmpeg!), ['-hide_banner','-loglevel','error','-y','-i', assetAbsPath(projectId, art.localPath), '-vf', filters.join(','), '-frames:v','1','-q:v','2', output], { timeout: 30000, maxBuffer: 1024 * 1024 })
  } catch { throw new Error('Thumbnail gagal dirender. Periksa gambar sumber dan FFmpeg.') }
  finally { rmSync(labels, { force: true }) }
  const asset = insertAsset({ projectId, kind: 'overlay', localPath: relative, width: L.width, height: L.height, prompt: pack.beforeLabel + ' | ' + pack.afterLabel })
  const latest = getAtmProduction(projectId)!.package!
  if (latest.artworkAssetId !== pack.artworkAssetId || latest.beforeLabel !== pack.beforeLabel || latest.afterLabel !== pack.afterLabel) throw new Error('Teks atau gambar berubah saat render. Render ulang thumbnail.')
  saveAtmPackage(projectId, { ...latest, thumbnailAssetId: asset.id })
  return getAtmProductionDetail(projectId)!
}

export async function renderAtmThumbnail(projectId: string): Promise<AtmProductionDetail> {
  return withThumbnailLock(projectId, () => renderUnlocked(projectId))
}
