import { createHash, randomUUID } from 'node:crypto'
import { editorialRevisionSchema } from '@shared/atmSchema'
import { getDb } from './db'
import { getBundle, getProject } from './repo'
import { getAtmProduction, getAtmProductionDetail, scriptHash } from './atmRepo'
import { saveAuthoredAtmPackage } from './atmGeneration'

/** Revise a reviewed draft atomically, preserving its prior outline/script and every reference asset. */
export function reviseUnproducedAtmScript(raw: unknown) {
  const input = editorialRevisionSchema.parse(raw)
  const db = getDb()
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return db.transaction(() => {
    const old = db.prepare('SELECT request_hash FROM atm_editorial_revisions WHERE project_id=? AND idempotency_key=?').get(input.projectId, input.idempotencyKey) as { request_hash: string } | undefined
    if (old) {
      if (old.request_hash !== requestHash) throw new Error('Key revisi sudah digunakan untuk perubahan berbeda.')
      return getAtmProductionDetail(input.projectId)
    }
    const production = getAtmProduction(input.projectId)
    if (!production) throw new Error('Project bukan produksi ATM.')
    if (scriptHash(input.projectId) !== input.expectedScriptHash) throw new Error('Naskah berubah sejak diperiksa. Baca versi terbaru sebelum merevisi.')
    const busy = db.prepare("SELECT id FROM atm_tasks WHERE project_id=? AND status='running' UNION ALL SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(input.projectId, input.projectId)
    if (busy) throw new Error('Tunggu pekerjaan aktif selesai sebelum merevisi naskah.')
    const media = db.prepare("SELECT id FROM assets WHERE project_id=? AND clip_id IS NOT NULL AND kind IN ('image','video','audio') LIMIT 1").get(input.projectId)
    if (media) throw new Error('Revisi ini hanya untuk draft sebelum media adegan dibuat. Media yang sudah dibuat tetap disimpan.')
    const bundle = getBundle(input.projectId)
    const ids = new Set(input.scenes.map(c => c.clipId))
    if (ids.size !== input.scenes.length || ids.size !== bundle.clips.length || bundle.clips.some(c => !ids.has(c.id))) throw new Error('Revisi harus mencakup setiap adegan project tepat sekali.')
    const before = JSON.stringify({ production, clips: bundle.clips })
    const project = getProject(input.projectId)
    const outlineHash = createHash('sha256').update(JSON.stringify([project.synopsis, project.durationSec, project.language, production.skillId])).digest('hex')
    db.prepare('UPDATE atm_productions SET outline_json=?,outline_hash=?,updated_at=? WHERE project_id=?').run(JSON.stringify(input.outline), outlineHash, Date.now(), input.projectId)
    const patch = db.prepare("UPDATE clips SET title=?,story=?,narration=?,visual_prompt='',visual_source=NULL WHERE id=? AND project_id=?")
    for (const scene of input.scenes) patch.run(scene.title, scene.story, scene.narration, scene.clipId, input.projectId)
    saveAuthoredAtmPackage(input.projectId, input.package)
    db.prepare('INSERT INTO atm_editorial_revisions (id,project_id,idempotency_key,request_hash,before_json,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), input.projectId, input.idempotencyKey, requestHash, before, Date.now())
    return getAtmProductionDetail(input.projectId)
  }).immediate()
}
