import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Asset, Character, Clip, Job } from '@shared/types'
import { characterVerdictSchema, type CharacterConsistencyStatus, type CharacterVerdict } from '@shared/characterConsistency'
import { getSceneStylePrompt } from '@shared/styles'
import { getDb } from './db'
import { assetAbsPath } from './paths'
import { charactersOf, clipsOf, getAsset, getClip, getJob, getProject, insertJob, updateAssetMeta } from './repo'
import { getSettings } from './settings'
import { emit } from './events'
import { cancelJob, runJob } from './jobs'
import { CHARACTER_REVIEW_MODEL, compareCharacterImages } from './services/characterVision'
import { sleep } from './services/http'

import { sceneImageFit, sceneImageId, sceneVideoId } from '@shared/flowV2'
import { visualReviewPolicy } from '@shared/visualReviewPolicy'
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export function sceneCharacters(clip: Clip, characters: Character[]): Character[] {
  const action = /^\s*Action:\s*(.*)$/im.exec(clip.visualPrompt)?.[1] ?? clip.visualPrompt.split('\n').filter(l => !/^\s*(Continuity|Avoid|Wardrobe):/i.test(l)).join('\n')
  return characters.filter(c => {
    const name = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return clip.characterIds.includes(c.id) || new RegExp('(?:^|[^\\p{L}\\p{N}])' + name + '(?=$|[^\\p{L}\\p{N}])', 'iu').test(action)
  })
}

export function imageData(asset: Asset): { url: string; hash: string } {
  const bytes = readFileSync(assetAbsPath(asset.projectId, asset.localPath))
  const mime = bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : null
  if (!mime || !bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('File gambar/referensi tidak valid atau terlalu besar.')
  return { url: 'data:' + mime + ';base64,' + bytes.toString('base64'), hash: digest(bytes) }
}

export function characterReferences(clip: Clip): { character: Character; asset: Asset; url: string; hash: string }[] {
  return sceneCharacters(clip, charactersOf(clip.projectId)).map(character => {
    const asset = getAsset(character.referenceImageAssetId ?? character.sheetAssetId)
    if (!asset || asset.projectId !== clip.projectId) throw new Error('Referensi karakter ' + character.name + ' belum tersedia. Buat lembar karakter dulu; referensi tidak akan dilewati.')
    return { character, asset, ...imageData(asset) }
  })
}

export function styleReference(projectId: string): Asset | null {
  getProject(projectId)
  const row = getDb().prepare("SELECT id FROM assets WHERE project_id=? AND kind='image' AND json_extract(meta_json,'$.styleReferenceFor') IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string } | undefined
  return row ? getAsset(row.id) : null
}

export function setStyleReference(projectId: string, assetId: string | null): CharacterConsistencyStatus {
  const project = getProject(projectId), asset = assetId === null ? null : getAsset(assetId)
  if (assetId !== null && (!asset || asset.projectId !== projectId || asset.kind !== 'image')) throw new Error('Acuan gaya harus gambar milik project ini.')
  if (asset) imageData(asset)
  getDb().transaction(() => {
    getDb().prepare("UPDATE assets SET meta_json=json_remove(meta_json,'$.styleReferenceFor') WHERE project_id=? AND json_extract(meta_json,'$.styleReferenceFor') IS NOT NULL").run(projectId)
    if (asset) getDb().prepare("UPDATE assets SET meta_json=json_set(meta_json,'$.styleReferenceFor',?) WHERE id=?").run(project.styleId, asset.id)
  })()
  return inspectCharacterConsistency(projectId)
}

export const requiresReview = (projectId: string): boolean => getSettings().imageReviewEnabled && (charactersOf(projectId).length > 0 || styleReference(projectId) !== null)

/** Keep the paid budget across jobs/restarts, until scene or reference inputs change. */
export function sceneImageBudgetKey(clipId: string): string {
  const clip = getClip(clipId), project = getProject(clip.projectId), anchor = styleReference(project.id)
  return 'scene-image-budget:' + digest(JSON.stringify({
    clipId, story: clip.story, prompt: clip.visualPrompt, cast: clip.characterIds,
    style: project.styleId, aspect: project.aspectRatio,
    refs: charactersOf(project.id).map(c => ({ id: c.id, name: c.name, description: c.description, hash: (c.referenceImageAssetId ?? c.sheetAssetId) ? imageData(getAsset(c.referenceImageAssetId ?? c.sheetAssetId)!).hash : null })),
    anchor: anchor ? imageData(anchor).hash : null
  }))
}

export function bestSceneCandidate(clipId: string, budgetKey: string): string | null {
  const rows = getDb().prepare("SELECT id FROM assets WHERE clip_id=? AND kind='image' AND json_extract(meta_json,'$.imageBudgetKey')=? ORDER BY created_at,id").all(clipId, budgetKey) as { id: string }[]
  // ponytail: rank existing inspection results; add comparative vision only if its extra cost is requested.
  const ranked = rows.flatMap(({ id }) => {
    const input = context(clipId, id), report = cachedReview(clipId, id, input.hash)
    if (!report) return []
    const issues = report.styleIssues.length + report.unexpectedForegroundCharacters.length + report.checks.reduce((n, c) => n + c.issues.length, 0)
    const matches = Number(report.styleMatches) + report.checks.filter(c => c.visible && c.identityMatches).length
    return [{ id, pass: Number(report.verdict === 'pass'), matches, issues }]
  }).sort((a, b) => b.pass - a.pass || b.matches - a.matches || a.issues - b.issues)
  return ranked[0]?.id ?? null
}

export function adoptLegacySceneCandidates(clipId: string, budgetKey: string): number {
  const rows = getDb().prepare("SELECT id FROM assets WHERE clip_id=? AND kind='image' AND provider IN ('9router','higgsfield') AND json_extract(meta_json,'$.imageBudgetKey') IS NULL").all(clipId) as { id: string }[]
  let count = 0
  for (const { id } of rows) {
    try {
      const input = context(clipId, id)
      if (!cachedReview(clipId, id, input.hash)) continue
      const asset = getAsset(id)!
      updateAssetMeta(id, { ...asset.meta, imageBudgetKey: budgetKey })
      count++
    } catch { /* Missing historical files cannot be reused; keep their records intact. */ }
  }
  return count
}

export function markBestEffort(clipId: string, assetId: string): void {
  const asset = getAsset(assetId)!
  updateAssetMeta(assetId, { ...asset.meta, visualFallbackHash: context(clipId, assetId).hash })
}

function context(clipId: string, assetId: string): { hash: string; prompt: string; images: string[]; expected: string[]; ids: string[] } {
  const clip = getClip(clipId), project = getProject(clip.projectId), chars = charactersOf(clip.projectId)
  const asset = getAsset(assetId)
  if (!asset || asset.projectId !== project.id || asset.kind !== 'image') throw new Error('Gambar adegan tidak ditemukan atau bukan milik project.')
  const candidate = imageData(asset)
  const refs = chars.map(c => {
    const sheet = getAsset(c.referenceImageAssetId ?? c.sheetAssetId)
    if (!sheet || sheet.projectId !== project.id) throw new Error('Referensi karakter ' + c.name + ' belum tersedia.')
    const data = imageData(sheet)
    return { id: c.id, name: c.name, description: c.description, sheetId: sheet.id, hash: data.hash, url: data.url }
  })
  const expected = sceneCharacters(clip, chars).map(c => c.id)
  if (clip.characterIds.some(id => !chars.some(c => c.id === id))) throw new Error('Pemeran adegan merujuk karakter yang tidak tersedia.')
  const anchor = styleReference(project.id), anchorData = anchor ? imageData(anchor) : null
  const identity = getDb().prepare('SELECT identity_snapshot FROM atm_productions WHERE project_id=?').get(project.id) as { identity_snapshot: string | null } | undefined
  const policy = visualReviewPolicy(identity?.identity_snapshot ? JSON.parse(identity.identity_snapshot).version : null)
  const details = { version: policy.version, ...(policy.narrativeRequired ? { narrativeRequired: true } : {}), style: project.styleId, ...(anchor?.id === assetId ? { styleReferenceIsCandidate: true } : {}), stylePrompt: getSceneStylePrompt(project.styleId, !!anchor), styleReference: anchor && anchorData ? { assetId: anchor.id, hash: anchorData.hash, imageIndex: refs.length + 2 } : null, aspect: project.aspectRatio, imageHash: candidate.hash, refs: refs.map(({ url: _url, ...r }) => r), expectedCharacters: expected, visualPrompt: clip.visualPrompt, story: clip.story }
  return { hash: digest(JSON.stringify(details)), expected, ids: chars.map(c => c.id),
    images: [candidate.url, ...refs.map(r => r.url), ...(anchorData ? [anchorData.url] : [])],
    prompt: 'IMAGE 1 is the candidate scene. The next ' + refs.length + ' images are character reference sheets in listed order. If styleReference is present, its imageIndex identifies a separate whole-frame STYLE reference; do not copy its characters, action or composition into a different scene. If styleReferenceIsCandidate is true, IMAGE 1 is the original selected source artwork itself; matching its own composition is expected and must not count as copying. Still check character identity and clothing. Check the entire image against stylePrompt and the style reference: background, palette, linework, shading and lighting. Correct stick characters over photographic/3D backgrounds FAIL a flat 2D style. styleMatches must be false for style drift and styleIssues must explain the mismatch. Check EVERY recurring foreground character, including undeclared characters that resemble a protagonist. An empty expectedCharacters list requires an environment shot without foreground protagonists. For each reference ID return one check; absent characters have visible=false. Expected characters must be visibly recognizable. A silhouette alone cannot certify hair/headwear/glasses. ' + policy.guidance + '\n\n' + JSON.stringify(details) }
}

function validatedVerdict(report: CharacterVerdict, expected: string[], ids: string[]): CharacterVerdict {
  if (!report.styleMatches || report.styleIssues.length) return { ...report, verdict: 'fail', reason: 'Gaya gambar tidak sesuai. ' + (report.styleIssues.join('; ') || report.reason), correction: [report.correction, ...report.styleIssues, 'Match the project style and supplied style reference across the entire frame, including backgrounds.'].filter(Boolean).join(' ').slice(0, 4000) }
  const got = report.checks.map(c => c.characterId)
  const complete = got.length === ids.length && new Set(got).size === ids.length && ids.every(id => got.includes(id))
  const matches = report.checks.every(c => (!c.visible || c.identityMatches) && !c.issues.length && (!expected.includes(c.characterId) || c.visible))
  const unexpected = report.checks.some(c => c.visible && !expected.includes(c.characterId)) || report.unexpectedForegroundCharacters.length > 0
  if (report.verdict === 'pass' && (!complete || !matches || unexpected)) return { ...report, verdict: 'uncertain', reason: 'Laporan persetujuan tidak lengkap atau bertentangan dengan pemeran/identitas adegan. ' + report.reason }
  return report
}

function cachedReview(clipId: string, assetId: string, hash: string): CharacterVerdict | null {
  const row = getDb().prepare('SELECT report_json FROM character_reviews WHERE clip_id=? AND asset_id=? AND input_hash=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(clipId, assetId, hash) as { report_json: string } | undefined
  return row ? characterVerdictSchema.parse(JSON.parse(row.report_json)) : null
}

export async function reviewCharacterCandidate(clipId: string, assetId: string, signal?: AbortSignal): Promise<CharacterVerdict> {
  const clip = getClip(clipId)
  if (!requiresReview(clip.projectId)) return { verdict: 'pass', styleMatches: true, styleIssues: [], checks: [], unexpectedForegroundCharacters: [], reason: 'Project tidak memiliki referensi karakter atau acuan gaya.', correction: '' }
  const input = context(clipId, assetId), old = cachedReview(clipId, assetId, input.hash)
  if (old) return old
  const report = validatedVerdict(await compareCharacterImages(input.prompt, input.images, signal), input.expected, input.ids)
  signal?.throwIfAborted()
  if (context(clipId, assetId).hash !== input.hash) throw new Error('Referensi atau adegan berubah saat diperiksa. Hasil lama tidak disetujui.')
  getDb().prepare('INSERT INTO character_reviews (id,project_id,clip_id,asset_id,input_hash,verdict,report_json,provider,model,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), clip.projectId, clipId, assetId, input.hash, report.verdict, JSON.stringify(report), '9router', CHARACTER_REVIEW_MODEL, Date.now())
  const asset = getAsset(assetId)!
  if (asset.meta.visualFallbackHash) {
    const { visualFallbackHash: _fallback, ...meta } = asset.meta
    updateAssetMeta(assetId, meta)
  }
  return report
}

export function inspectCharacterConsistency(projectId: string): CharacterConsistencyStatus {
  getProject(projectId)
  const clips = clipsOf(projectId), required = requiresReview(projectId), anchor = styleReference(projectId)
  const scenes: CharacterConsistencyStatus['scenes'] = clips.map((clip, i) => {
    const activeImage = sceneImageId(clip)
    const base = { clipId: clip.id, scene: i + 1, title: clip.title, assetId: activeImage, inputHash: null }
    if (clip.importedImageAssetId) return { ...base, status: 'best-effort', inputHash: sceneImageFit(clip), reason: 'Gambar dipilih secara manual lewat impor.' }
    if (!getSettings().imageReviewEnabled) return { ...base, status: 'manual', reason: 'Pemeriksaan otomatis nonaktif. Tinjau gambar secara manual.' }
    if (!required) return { ...base, status: 'pass', reason: 'Tidak ada referensi karakter pada project.' }
    if (sceneVideoId(clip)) return { ...base, status: 'blocked', reason: 'Klip video belum memiliki pemeriksaan karakter untuk seluruh geraknya. Gunakan gerak kamera pada gambar yang sudah lolos.' }
    if (!activeImage) return { ...base, status: 'blocked', reason: 'Gambar adegan belum tersedia.' }
    try {
      const input = context(clip.id, activeImage), review = cachedReview(clip.id, activeImage, input.hash)
      if (review && review.verdict !== 'pass' && getAsset(activeImage)?.meta.visualFallbackHash === input.hash) return { ...base, inputHash: input.hash, status: 'best-effort', reason: 'Batas tiga kandidat tercapai; hasil terbaik dipilih. Tinjau manual: ' + review.reason }
      return { ...base, inputHash: input.hash, status: review?.verdict ?? 'unreviewed', reason: review?.reason ?? 'Gambar/referensi ini belum diperiksa atau berubah setelah pemeriksaan.' }
    } catch (e) { return { ...base, status: 'blocked', reason: (e as Error).message } }
  })
  return { projectId, required, ready: !required || scenes.every(s => s.status === 'pass' || s.status === 'best-effort'), passed: scenes.filter(s => s.status === 'pass').length, total: scenes.length, scenes, styleReference: anchor ? { assetId: anchor.id, url: anchor.url } : null }
}

export function assertCharacterConsistency(projectId: string): string {
  const status = inspectCharacterConsistency(projectId)
  if (!status.ready) throw new Error('Export ditahan: ' + status.scenes.filter(s => s.status !== 'pass').map(s => 'adegan ' + s.scene + ': ' + s.reason).slice(0, 4).join('; ') + '. Jalankan Periksa & perbaiki karakter.')
  return digest(JSON.stringify([getSettings().imageReviewEnabled, status.scenes.map(s => [s.clipId, s.assetId, s.status, s.inputHash])]))
}

export function assertLatestExportCharacterApproval(projectId: string): void {
  if (!requiresReview(projectId)) return
  const current = assertCharacterConsistency(projectId)
  const row = getDb().prepare("SELECT payload_json FROM jobs WHERE project_id=? AND kind='export' AND status='done' AND message IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(projectId) as { payload_json: string } | undefined
  if (!row || JSON.parse(row.payload_json).characterSnapshot !== current) throw new Error('MP4 terakhir belum berasal dari gambar dan referensi yang saat ini disetujui. File lama tetap disimpan; export ulang project untuk mengunduh versi siap publikasi.')
}

export function startCharacterConsistencyReview(projectId: string, repair: boolean, idempotencyKey?: string): Job {
  getProject(projectId)
  if (idempotencyKey) {
    const prior = getDb().prepare("SELECT id,payload_json FROM jobs WHERE project_id=? AND kind='character-review' AND json_extract(payload_json,'$.idempotencyKey')=? ORDER BY created_at DESC LIMIT 1").get(projectId, idempotencyKey) as { id: string; payload_json: string } | undefined
    if (prior) {
      if (JSON.parse(prior.payload_json).repair !== repair) throw new Error('Idempotency key sudah dipakai untuk mode pemeriksaan berbeda.')
      return getJob(prior.id)!
    }
  }
  const existing = getDb().prepare("SELECT id FROM jobs WHERE project_id=? AND kind='character-review' AND status IN ('queued','running') LIMIT 1").get(projectId) as { id: string } | undefined
  if (existing) return getJob(existing.id)!
  const job = insertJob({ projectId, kind: 'character-review', provider: '9router', payload: { repair, idempotencyKey: idempotencyKey || randomUUID() } })
  emit.job(job)
  return runJob(job, 'review', async ctx => {
    const clips = clipsOf(projectId)
    for (let i = 0; i < clips.length; i++) {
      ctx.signal.throwIfAborted()
      const clip = getClip(clips[i].id)
      ctx.progress(i / Math.max(1, clips.length), 'Memeriksa karakter adegan ' + (i + 1) + '/' + clips.length)
      if (!requiresReview(projectId) || clip.importedImageAssetId) continue
      if (clip.motionType === 'video' && clip.videoAssetId) throw new Error('Adegan ' + (i + 1) + ' memakai video bergerak yang belum dapat disetujui oleh pemeriksa gambar.')
      const report = clip.imageAssetId ? await reviewCharacterCandidate(clip.id, clip.imageAssetId, ctx.signal) : null
      if (report?.verdict === 'pass' || !repair) continue
      const { generateClipImage } = await import('./generation')
      const child = generateClipImage(clip.id)
      const abort = (): void => { void cancelJob(child.id) }
      ctx.signal.addEventListener('abort', abort, { once: true })
      try {
        while (['queued', 'running'].includes(getJob(child.id)!.status)) await sleep(500, ctx.signal)
        const done = getJob(child.id)!
        if (done.status !== 'done') throw new Error('Perbaikan adegan ' + (i + 1) + ' berhenti: ' + (done.error || done.status))
      } finally { ctx.signal.removeEventListener('abort', abort) }
    }
    const status = inspectCharacterConsistency(projectId)
    if (repair && !status.ready) throw new Error('Masih ada adegan yang belum siap. Tinjau gambar atau nonaktifkan pemeriksaan otomatis di Pengaturan > Umum.')
    const manual = status.scenes.filter(s => s.status === 'best-effort' || s.status === 'manual').length
    return { message: status.passed + '/' + status.total + ' adegan lolos pemeriksaan karakter.' + (manual ? ' ' + manual + ' adegan perlu tinjau manual; tidak dibuat ulang otomatis.' : '') }
  })
}
