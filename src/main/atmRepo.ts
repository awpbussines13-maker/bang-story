import { createHash, randomUUID } from 'node:crypto'
import { listAtmTasks } from './atmTasks'
import { getDb } from './db'
import { clipsOf, createProject, getAsset, getBundle, getProject, getLatestExportPath } from './repo'
import { inspectCharacterConsistency } from './characterConsistency'
import { channelIdentityContext, resolveChannelIdentity, installChannelIdentity } from './atmIdentity'
import { renderAssetFingerprint } from './renderAssetFingerprint'
import { assetAbsPath } from './paths'
import { productionInputSchema, referenceInputSchema, skillInputSchema, workspaceInputSchema } from '@shared/atmSchema'
import type { AtmBundle, AtmPackage, AtmProduction, AtmProductionDetail, AtmProductionInput, AtmProductionSummary, AtmReference, AtmReferenceInput, AtmSkill, AtmSkillInput, AtmWorkspace, AtmWorkspaceInput } from '@shared/atm'

type Row = Record<string, any>
const workspaceOf = (r: Row): AtmWorkspace => ({ id: r.id, name: r.name, channelUrl: r.channel_url, language: r.language, notes: r.notes, activeSkillId: r.active_skill_id, createdAt: r.created_at, updatedAt: r.updated_at })
const referenceOf = (r: Row): AtmReference => ({ id: r.id, workspaceId: r.workspace_id, url: r.url, title: r.title, thumbnailUrl: r.thumbnail_url, description: r.description, transcript: r.transcript, videoAnalysis: r.video_analysis, transcriptStatus: r.transcript_status, notes: r.notes, viewCount: r.view_count, publishedAt: r.published_at, capturedAt: r.captured_at })
const skillOf = (r: Row): AtmSkill => ({ id: r.id, workspaceId: r.workspace_id, version: r.version, name: r.name, instructions: r.instructions, analysis: r.analysis, sourceIds: JSON.parse(r.source_ids), evidence: r.evidence, createdAt: r.created_at })
const productionOf = (r: Row): AtmProduction => ({ projectId: r.project_id, workspaceId: r.workspace_id, skillId: r.skill_id, skillSnapshot: JSON.parse(r.skill_snapshot), brief: r.brief, identitySnapshot: r.identity_snapshot ? JSON.parse(r.identity_snapshot) : null, outline: r.outline_json ? JSON.parse(r.outline_json) : null, package: r.package_json ? JSON.parse(r.package_json) : null, createdAt: r.created_at, updatedAt: r.updated_at })

export function listAtmWorkspaces(): AtmWorkspace[] {
  return (getDb().prepare('SELECT * FROM atm_workspaces ORDER BY updated_at DESC').all() as Row[]).map(workspaceOf)
}

export function getAtmWorkspace(id: string): AtmWorkspace {
  const row = getDb().prepare('SELECT * FROM atm_workspaces WHERE id = ?').get(id) as Row | undefined
  if (!row) throw new Error('Ruang ATM tidak ditemukan.')
  return workspaceOf(row)
}

export function saveAtmWorkspace(raw: AtmWorkspaceInput): AtmWorkspace {
  const p = workspaceInputSchema.parse(raw)
  const now = Date.now()
  if (p.id) {
    const current = getAtmWorkspace(p.id)
    getDb().prepare('UPDATE atm_workspaces SET name=?, channel_url=?, language=?, notes=?, updated_at=? WHERE id=?')
      .run(p.name, p.channelUrl ?? current.channelUrl, p.language ?? current.language, p.notes ?? current.notes, now, p.id)
    return getAtmWorkspace(p.id)
  }
  const id = randomUUID()
  getDb().prepare('INSERT INTO atm_workspaces (id,name,channel_url,language,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, p.name, p.channelUrl ?? '', p.language ?? 'en', p.notes ?? '', now, now)
  return getAtmWorkspace(id)
}

export function listAtmReferences(workspaceId: string): AtmReference[] {
  return (getDb().prepare('SELECT * FROM atm_references WHERE workspace_id=? ORDER BY captured_at DESC').all(workspaceId) as Row[]).map(referenceOf)
}

export function saveAtmReference(raw: AtmReferenceInput): AtmReference {
  const p = referenceInputSchema.parse(raw)
  getAtmWorkspace(p.workspaceId)
  const current = p.id ? listAtmReferences(p.workspaceId).find((r) => r.id === p.id) : null
  if (p.id && !current) throw new Error('Referensi bukan milik ruang ATM ini.')
  const id = p.id ?? randomUUID()
  const transcript = p.transcript ?? current?.transcript ?? ''
  const transcriptStatus = transcript.trim() ? (p.transcriptStatus === 'fetched' ? 'fetched' : current?.transcriptStatus === 'fetched' && transcript === current.transcript ? 'fetched' : 'provided') : 'missing'
  getDb().prepare('INSERT INTO atm_references (id,workspace_id,url,title,thumbnail_url,description,transcript,transcript_status,video_analysis,notes,view_count,published_at,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,title=excluded.title,thumbnail_url=excluded.thumbnail_url,description=excluded.description,transcript=excluded.transcript,transcript_status=excluded.transcript_status,video_analysis=excluded.video_analysis,notes=excluded.notes,view_count=excluded.view_count,published_at=excluded.published_at')
    .run(id, p.workspaceId, p.url ?? current?.url ?? '', p.title, p.thumbnailUrl ?? current?.thumbnailUrl ?? '', p.description ?? current?.description ?? '', transcript, transcriptStatus, p.videoAnalysis ?? current?.videoAnalysis ?? '', p.notes ?? current?.notes ?? '', p.viewCount === undefined ? current?.viewCount ?? null : p.viewCount, p.publishedAt ?? current?.publishedAt ?? '', current?.capturedAt ?? Date.now())
  return listAtmReferences(p.workspaceId).find((r) => r.id === id)!
}

export function removeAtmReference(workspaceId: string, referenceId: string): void {
  getAtmWorkspace(workspaceId)
  getDb().prepare('DELETE FROM atm_references WHERE id=? AND workspace_id=?').run(referenceId, workspaceId)
}

export function listAtmSkills(workspaceId: string): AtmSkill[] {
  return (getDb().prepare('SELECT * FROM atm_skills WHERE workspace_id=? ORDER BY version DESC').all(workspaceId) as Row[]).map(skillOf)
}

export function saveAtmSkill(raw: AtmSkillInput): AtmSkill {
  const p = skillInputSchema.parse(raw)
  getAtmWorkspace(p.workspaceId)
  const refs = listAtmReferences(p.workspaceId)
  const ids = p.sourceIds ?? refs.map((r) => r.id)
  if (ids.some((id) => !refs.some((r) => r.id === id))) throw new Error('Sumber skill harus berasal dari ruang ATM yang sama.')
  return getDb().transaction(() => {
    const version = (listAtmSkills(p.workspaceId)[0]?.version ?? 0) + 1
    const id = randomUUID()
    const hasTranscript = refs.some((r) => ids.includes(r.id) && r.transcript.trim())
    const hasVideo = refs.some((r) => ids.includes(r.id) && r.videoAnalysis.trim())
    const evidence = hasTranscript && hasVideo ? 'mixed' : hasTranscript ? 'transcripts' : hasVideo ? 'video' : 'metadata'
    getDb().prepare('INSERT INTO atm_skills (id,workspace_id,version,name,instructions,analysis,source_ids,evidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, p.workspaceId, version, p.name, p.instructions, p.analysis ?? '', JSON.stringify(ids), evidence, Date.now())
    return listAtmSkills(p.workspaceId).find((s) => s.id === id)!
  })()
}

export function activateAtmSkill(workspaceId: string, skillId: string): AtmWorkspace {
  const skill = listAtmSkills(workspaceId).find((s) => s.id === skillId)
  if (!skill) throw new Error('Skill bukan milik ruang ATM ini.')
  getDb().prepare('UPDATE atm_workspaces SET active_skill_id=?, updated_at=? WHERE id=?').run(skillId, Date.now(), workspaceId)
  return getAtmWorkspace(workspaceId)
}

export function getAtmProduction(projectId: string): AtmProduction | null {
  const row = getDb().prepare('SELECT * FROM atm_productions WHERE project_id=?').get(projectId) as Row | undefined
  return row ? productionOf(row) : null
}

export function scriptHash(projectId: string): string {
  return createHash('sha256').update(JSON.stringify(clipsOf(projectId).map((c) => [c.story, c.narration]))).digest('hex')
}

export function atmRenderHash(projectId: string): string {
  const bundle = getBundle(projectId)
  const characters = inspectCharacterConsistency(projectId).scenes.map(s => [s.clipId, s.inputHash, s.status])
  const active = new Set(bundle.clips.flatMap(c => [c.imageAssetId, c.videoAssetId, c.audioAssetId]).filter((id): id is string => !!id))
  if (bundle.project.editor.musicAssetId) active.add(bundle.project.editor.musicAssetId)
  if (bundle.project.editor.soundDesign?.enabled) for (const cue of bundle.project.editor.soundDesign.cues) if (cue.assetId && !cue.muted) active.add(cue.assetId)
  for (const overlay of bundle.project.editor.overlays) if (overlay.kind === 'image') active.add(overlay.assetId)
  const media = [...active].sort().map(id => {
    const asset = getAsset(id)
    return asset ? renderAssetFingerprint(asset, assetAbsPath(projectId, asset.localPath)) : [id, 'unavailable']
  })
  return createHash('sha256').update(JSON.stringify(['render-inputs-v2', bundle.project.aspectRatio, bundle.project.editor, bundle.clips, characters, media])).digest('hex')
}

export function atmExportIsCurrent(projectId: string): boolean {
  const row = getDb().prepare('SELECT export_hash FROM atm_productions WHERE project_id=?').get(projectId) as Row | undefined
  return row?.export_hash === atmRenderHash(projectId)
}

export function atmProductionSummary(p: AtmProduction): AtmProductionSummary {
  const bundle = getBundle(p.projectId)
  const pack = p.package
  const exported = getLatestExportPath(p.projectId)
  const row = getDb().prepare('SELECT export_hash FROM atm_productions WHERE project_id=?').get(p.projectId) as { export_hash: string | null }
  return { projectId: p.projectId, title: bundle.project.title, skillVersion: p.skillSnapshot.version, status: bundle.project.status,
    sceneCount: bundle.clips.length, imagesReady: bundle.clips.filter((c) => c.imageAssetId).length, voicesReady: bundle.clips.filter((c) => c.audioAssetId).length,
    thumbnailUrl: getAsset(pack?.thumbnailAssetId ?? null)?.url ?? null, packageStale: !!pack && pack.scriptHash !== scriptHash(p.projectId), exportStale: !!exported && !atmExportIsCurrent(p.projectId), exportFingerprint: exported ? row.export_hash : null }
}

export function getAtmProductionDetail(projectId: string): AtmProductionDetail | null {
  const p = getAtmProduction(projectId)
  if (!p) return null
  const s = atmProductionSummary(p)
  const nextAction = !s.sceneCount ? 'Buat naskah dengan skill tersimpan' : s.packageStale ? 'Perbarui judul dan thumbnail sesuai naskah terbaru'
    : !p.package ? 'Siapkan judul dan konsep thumbnail' : s.imagesReady < s.sceneCount ? 'Lanjutkan rencana visual dan gambar di editor'
    : s.voicesReady < s.sceneCount ? 'Buat narasi di editor' : s.exportStale ? 'Isi project berubah; lanjutkan produksi untuk memperbarui MP4' : !s.thumbnailUrl ? 'Buat thumbnail' : s.status !== 'exported' ? 'Tinjau lalu ekspor video di editor' : 'Video dan paket publikasi siap'
  return { production: p, summary: s, artworkUrl: getAsset(p.package?.artworkAssetId ?? null)?.url ?? null, thumbnailUrl: s.thumbnailUrl, nextAction }
}

export function getAtmBundle(workspaceId: string): AtmBundle {
  const productions = (getDb().prepare('SELECT * FROM atm_productions WHERE workspace_id=? ORDER BY created_at DESC').all(workspaceId) as Row[]).map(productionOf)
  return { workspace: getAtmWorkspace(workspaceId), references: listAtmReferences(workspaceId), skills: listAtmSkills(workspaceId), productions: productions.map(atmProductionSummary), tasks: listAtmTasks(workspaceId) }
}

export function createAtmProduction(raw: AtmProductionInput): AtmProductionDetail {
  const p = productionInputSchema.parse(raw)
  const workspace = getAtmWorkspace(p.workspaceId)
  const requestHash = createHash('sha256').update(JSON.stringify(p)).digest('hex')
  const old = getDb().prepare('SELECT project_id,request_hash FROM atm_productions WHERE workspace_id=? AND idempotency_key=?').get(p.workspaceId, p.idempotencyKey) as Row | undefined
  if (old) {
    if (old.request_hash !== requestHash) throw new Error('Idempotency key sudah digunakan untuk brief yang berbeda.')
    return getAtmProductionDetail(old.project_id)!
  }
  const skillId = p.skillId ?? workspace.activeSkillId
  const skill = listAtmSkills(p.workspaceId).find((s) => s.id === skillId)
  if (!skill) throw new Error('Aktifkan versi skill dulu sebelum membuat produksi.')
  const identity = resolveChannelIdentity(p.workspaceId, p.channelId)
  return getDb().transaction(() => {
    const project = createProject({ synopsis: p.synopsis, durationSec: p.durationSec ?? 540, language: p.language ?? workspace.language, aspectRatio: '16:9', styleId: 'stickman' })
    const now = Date.now()
    getDb().prepare('INSERT INTO atm_productions (project_id,workspace_id,skill_id,skill_snapshot,brief,idempotency_key,request_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(project.id, p.workspaceId, skill.id, JSON.stringify(skill), p.synopsis, p.idempotencyKey, requestHash, now, now)
    if (identity) {
      const snapshot = installChannelIdentity(project.id, identity)
      getDb().prepare('UPDATE atm_productions SET identity_snapshot=? WHERE project_id=?').run(JSON.stringify(snapshot), project.id)
    }
    return getAtmProductionDetail(project.id)!
  })()
}

export function saveAtmPackage(projectId: string, pack: AtmPackage): void {
  if (!getAtmProduction(projectId)) throw new Error('Project belum terhubung ke ruang ATM.')
  getDb().prepare('UPDATE atm_productions SET package_json=?, updated_at=? WHERE project_id=?').run(JSON.stringify(pack), Date.now(), projectId)
}

export function atmStoryContext(projectId: string): string {
  const p = getAtmProduction(projectId)
  if (!p) return ''
  return [
    'EDITORIAL SKILL SNAPSHOT (apply to story decisions; original fiction, no source dialogue or plot copying):',
    'Skill: ' + p.skillSnapshot.name + ' / version ' + p.skillSnapshot.version,
    p.skillSnapshot.instructions,
    channelIdentityContext(p.identitySnapshot),
    p.outline ? 'Visual continuity anchor from the episode outline: ' + p.outline.protagonist : '',
    'Original episode brief: ' + getProject(projectId).synopsis
  ].join('\n\n')
}
