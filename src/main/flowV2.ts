import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { FLOW_IMAGE_LIMIT, FLOW_ZIP_LIMIT, clipFlowId, flowClipLabel, withReferenceStyle, type FlowImageChange, type FlowImportPreview, type FlowProjectV2 } from '@shared/flowV2'
import { getStyle } from '@shared/styles'
import type { Asset, Clip, ImageFit } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { decodeFlowImage } from './flowImageCodec'
import { fetchFlowImage } from './flowImageUrl'
import { assetAbsPath } from './paths'
import { getAsset, getBundle, getCharacter, getClip, insertAsset, patchClip, touchProject } from './repo'
import { makeZip, readZipArchive, type ZipEntry } from './zipArchive'

const IMAGE_NAME = /\.(?:jpe?g|png|webp)$/i

function flowManifest(projectId: string) {
  const { project, characters, clips } = getBundle(projectId)
  const castIds = new Map(characters.map((c) => [c.id, c.flowId!]))
  const sceneLabels = clips.map((c, i) => flowClipLabel(i, c.title))
  const manifest: FlowProjectV2 = {
    app: 'bang-story',
    formatVersion: 2,
    projectTitle: project.title,
    language: project.language,
    aspectRatio: project.aspectRatio,
    visualStyle: getStyle(project.styleId).prompt,
    characters: characters.map((c) => {
      const referencePrompt = withReferenceStyle(c.referencePrompt, project.styleId)
      if (!referencePrompt) throw new Error(`Karakter ${c.name} belum punya prompt referensi. Isi dulu di dialog pemeran.`)
      return {
        id: c.flowId!, name: c.name, description: c.description, referencePrompt,
        referenceImage: (c.referenceImageAssetId ?? c.sheetAssetId) ? `characters/${c.flowId}-character-sheet.webp` : null
      }
    }),
    scenes: clips.map((c, i) => {
      const characterIds = c.characterIds.map((id) => {
        const flowId = castIds.get(id)
        if (!flowId) throw new Error(`${sceneLabels[i]} merujuk karakter yang sudah tidak ada. Perbaiki dulu.`)
        return flowId
      })
      return { id: c.flowId!, title: c.title, narration: c.narration, visualPrompt: c.visualPrompt, characterIds }
    })
  }
  return { manifest, characters, emptyScenes: sceneLabels.filter((_label, i) => !manifest.scenes[i].characterIds.length) }
}

export function flowExportSummary(projectId: string): string[] {
  return flowManifest(projectId).emptyScenes
}

export async function buildFlowV2Zip(projectId: string, confirmed: boolean): Promise<{ fileName: string; zipBuffer: Buffer }> {
  const { manifest, characters, emptyScenes } = flowManifest(projectId)
  if (emptyScenes.length && confirmed !== true) throw new Error(`${emptyScenes.join(', ')} tidak memakai karakter. Konfirmasi untuk lanjut.`)
  const entries: ZipEntry[] = [{ name: 'project.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), compress: true }]
  let size = entries[0].data.length
  for (const record of manifest.characters) {
    if (!record.referenceImage) continue
    const character = characters.find((c) => c.flowId === record.id)!
    const asset = getAsset(character.referenceImageAssetId ?? character.sheetAssetId)
    if (asset?.projectId !== projectId || asset.characterId !== character.id || asset.kind !== 'image')
      throw new Error(`Gambar referensi ${record.name} tidak ditemukan. Unggah ulang di dialog pemeran.`)
    let data: Buffer
    try { data = readFileSync(assetAbsPath(projectId, asset.localPath)) } catch {
      throw new Error(`Gambar referensi ${record.name} tidak ditemukan. Unggah ulang di dialog pemeran.`)
    }
    if (extname(asset.localPath).toLowerCase() !== '.webp') {
      try { data = (await decodeFlowImage(data, 'webp')).output } catch {
        throw new Error(`Gambar referensi ${record.name} tidak bisa dikonversi. Unggah ulang di dialog pemeran.`)
      }
    }
    size += data.length
    if (size > FLOW_ZIP_LIMIT) throw new Error('Ukuran paket Google Flow melebihi 96 MB.')
    entries.push({ name: record.referenceImage, data })
  }
  const title = manifest.projectTitle.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, '-').slice(0, 100) || 'proyek'
  return { fileName: `${title}-flow-export.zip`, zipBuffer: makeZip(entries) }
}

function uploadBytes(input: unknown, limit: number): Buffer {
  const bytes = ArrayBuffer.isView(input) && input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    : input instanceof ArrayBuffer ? Buffer.from(input) : null
  if (!bytes?.length || bytes.length > limit) throw new Error(`Pilih file dengan ukuran maksimal ${limit / (1024 * 1024)} MB.`)
  return bytes
}

function saveImages<T>(projectId: string, save: (write: (data: Buffer) => string) => T): T {
  const written: string[] = []
  try {
    return getDb().transaction(() => save((data) => {
      const path = `imports/${randomUUID()}.webp`
      const absolute = assetAbsPath(projectId, path)
      mkdirSync(dirname(absolute), { recursive: true })
      written.push(absolute)
      writeFileSync(absolute, data, { flag: 'wx' })
      return path
    }))()
  } catch (err) {
    for (const file of written) rmSync(file, { force: true })
    throw err
  }
}

export async function setFlowReference(projectId: string, characterId: string, input: unknown): Promise<Asset | null> {
  const before = getCharacter(characterId)
  if (before.projectId !== projectId) throw new Error('Pemeran tidak ada di proyek ini.')
  const decoded = input === null ? null : await decodeFlowImage(uploadBytes(input, FLOW_IMAGE_LIMIT), 'webp')
  const asset = saveImages(projectId, (write) => {
    const current = getCharacter(characterId)
    if (current.referenceImageAssetId !== before.referenceImageAssetId) throw new Error('Gambar referensi sudah berubah. Coba lagi.')
    const asset = decoded && insertAsset({ projectId, characterId, kind: 'image', provider: 'import', localPath: write(decoded.output), width: decoded.width, height: decoded.height })
    getDb().prepare('UPDATE characters SET reference_image_asset_id = ? WHERE id = ?').run(asset?.id ?? null, characterId)
    touchProject(projectId)
    return asset
  })
  if (asset) emit.asset(asset)
  emit.character({ characterId, patch: { referenceImageAssetId: asset?.id ?? null } })
  return asset
}

function imageFit(input: unknown): ImageFit {
  if (input !== 'cover' && input !== 'contain') throw new Error('Pilih Isi atau Muat untuk gambar.')
  return input
}

function publish(change: FlowImageChange): void {
  if (change.asset) emit.asset(change.asset)
  emit.clip({ clipId: change.clipId, patch: { importedImageAssetId: change.asset?.id ?? null, imageFit: change.imageFit } })
}

function ownedClip(projectId: string, clipId: string): Clip {
  const clip = getClip(clipId)
  if (clip.projectId !== projectId) throw new Error('Klip tidak ada di proyek ini.')
  return clip
}

async function commitImages(projectId: string, selected: { clip: Clip; bytes: Buffer }[], fit: ImageFit): Promise<FlowImageChange[]> {
  const decoded: { clip: Clip; image: Awaited<ReturnType<typeof decodeFlowImage>> }[] = []
  for (const { clip, bytes } of selected) decoded.push({ clip, image: await decodeFlowImage(bytes, 'webp') })
  const changes = saveImages(projectId, (write) => {
    const changes = decoded.map(({ clip, image }) => {
      const current = ownedClip(projectId, clip.id)
      if (current.importedImageAssetId !== clip.importedImageAssetId || current.imageFit !== clip.imageFit)
        throw new Error(`Gambar pada ${flowClipLabel(current.sort, current.title)} sudah berubah. Coba impor lagi.`)
      const asset = insertAsset({ projectId, clipId: clip.id, kind: 'image', provider: 'import', localPath: write(image.output), width: image.width, height: image.height })
      patchClip(clip.id, { importedImageAssetId: asset.id, imageFit: fit })
      return { clipId: clip.id, asset, imageFit: fit }
    })
    touchProject(projectId)
    return changes
  })
  changes.forEach(publish)
  return changes
}

export async function importFlowImage(projectId: string, clipId: string, input: unknown, fit: unknown, fromUrl = false): Promise<FlowImageChange> {
  const clip = ownedClip(projectId, clipId)
  const framing = imageFit(fit)
  const bytes = fromUrl ? await fetchFlowImage(input as string) : uploadBytes(input, FLOW_IMAGE_LIMIT)
  return (await commitImages(projectId, [{ clip, bytes }], framing))[0]
}

export function changeFlowImage(projectId: string, clipId: string, fit: unknown): FlowImageChange {
  const clip = ownedClip(projectId, clipId)
  const asset = fit === null ? null : getAsset(clip.importedImageAssetId)
  const framing = fit === null ? 'cover' : imageFit(fit)
  if (fit !== null && !asset) throw new Error('Klip belum punya gambar impor.')
  patchClip(clipId, { importedImageAssetId: asset?.id ?? null, imageFit: framing })
  touchProject(projectId)
  const change = { clipId, asset, imageFit: framing }
  publish(change)
  return change
}

interface StagedZip {
  projectId: string
  clips: Clip[]
  files: Map<string, Buffer>
  size: number
  expires: number
}
const stagedZips = new Map<string, StagedZip>()
let previewsInProgress = 0

export function matchFlowImages(clips: { id: string }[], names: string[]): Map<string, string> {
  const stems = names.map((name) => basename(name, extname(name)).toLowerCase())
  const shortIds = new Set(clips.map((_clip, i) => clipFlowId(i)))
  const oldIds = new Set(clips.map((clip) => clip.id.toLowerCase()))
  const matches = new Map<string, string>()
  for (const [index, clip] of clips.entries()) {
    const short = names.filter((_name, i) => stems[i] === clipFlowId(index))
    const legacy = names.filter((_name, i) => !shortIds.has(stems[i]) && stems[i] === clip.id.toLowerCase())
    const numeric = names.filter((_name, i) => !shortIds.has(stems[i]) && !oldIds.has(stems[i])
      && !/^[0-9a-f-]{36}$/.test(stems[i]) && Number(/(\d+)$/.exec(stems[i])?.[1]) === index + 1)
    const candidates = short.length ? short : legacy.length ? legacy : numeric
    if (candidates.length === 1) matches.set(candidates[0], clip.id)
  }
  return matches
}

export async function previewFlowZip(projectId: string, input: unknown): Promise<FlowImportPreview> {
  const { clips } = getBundle(projectId)
  if (previewsInProgress >= 2) throw new Error('Pratinjau ZIP sedang diproses. Coba sebentar lagi.')
  previewsInProgress++
  try {
    const files = readZipArchive(uploadBytes(input, FLOW_ZIP_LIMIT), { maxTotalBytes: 256 * 1024 * 1024, maxEntries: 1024, maxEntryBytes: FLOW_IMAGE_LIMIT })
    const images: FlowImportPreview['images'] = []
    for (const [name, bytes] of files) {
      if (!IMAGE_NAME.test(name) || name.startsWith('__MACOSX/') || basename(name).startsWith('.')) {
        files.delete(name)
        continue
      }
      try {
        const { output } = await decodeFlowImage(bytes, 'thumbnail')
        images.push({ name, thumbnail: `data:image/jpeg;base64,${output.toString('base64')}`, clipId: null })
      } catch {
        throw new Error(`Gambar “${name}” tidak valid atau melebihi batas 10 MB.`)
      }
    }
    if (!images.length) throw new Error('ZIP tidak berisi gambar JPG, PNG, atau WebP.')
    const size = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)
    for (const [token, data] of stagedZips) {
      if (data.expires < Date.now() || data.projectId === projectId) stagedZips.delete(token)
    }
    for (const [token] of stagedZips) {
      if ([...stagedZips.values()].reduce((sum, data) => sum + data.size, size) <= 256 * 1024 * 1024) break
      stagedZips.delete(token)
    }
    const token = randomUUID()
    stagedZips.set(token, { projectId, clips, files, size, expires: Date.now() + 30 * 60_000 })
    const timer = setTimeout(() => stagedZips.delete(token), 30 * 60_000)
    timer.unref()
    const suggested = matchFlowImages(clips, images.map(i => i.name))
    return { token, images: images.map((image) => ({ ...image, clipId: suggested.get(image.name) ?? null })),
      scenes: clips.map((c, i) => ({ id: c.id, label: flowClipLabel(i, c.title) })) }
  } finally {
    previewsInProgress--
  }
}

export async function applyFlowZip(projectId: string, token: string, mapping: unknown, fit: unknown): Promise<FlowImageChange[]> {
  const staged = stagedZips.get(token)
  if (!staged || staged.projectId !== projectId || staged.expires < Date.now()) throw new Error('Pratinjau ZIP kedaluwarsa. Pilih ZIP lagi.')
  const framing = imageFit(fit)
  if (!Array.isArray(mapping) || !mapping.length || mapping.length > staged.clips.length) throw new Error('Pilih minimal satu gambar untuk diterapkan.')
  const usedClips = new Set<string>()
  const usedImages = new Set<string>()
  const selected = mapping.map((item: { clipId: string; image: string } | null) => {
    const clip = staged.clips.find((c) => c.id === item?.clipId)
    const bytes = item && staged.files.get(item.image)
    if (!clip || !item || !bytes || usedClips.has(clip.id) || usedImages.has(item.image))
      throw new Error('Setiap gambar harus dipetakan ke satu scene yang berbeda.')
    usedClips.add(clip.id)
    usedImages.add(item.image)
    return { clip, bytes }
  })
  const { clips } = getBundle(projectId)
  if (clips.length !== staged.clips.length || clips.some((c, i) => c.id !== staged.clips[i].id))
    throw new Error('Urutan atau jumlah scene berubah. Buka pratinjau ZIP lagi.')
  stagedZips.delete(token)
  try {
    return await commitImages(projectId, selected, framing)
  } catch (err) {
    if (staged.expires > Date.now() && ![...stagedZips.values()].some((zip) => zip.projectId === projectId)) stagedZips.set(token, staged)
    throw err
  }
}
