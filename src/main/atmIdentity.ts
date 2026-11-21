import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getDb } from './db'
import { charactersOf, getAsset, insertAsset, setCharacterSheet, getProject } from './repo'
import { assetAbsPath, projectDir } from './paths'
import type { IdentitySnapshot } from '@shared/atm'

type Sheet = { name: string; description: string; bytes: string; hash: string; extension: string; width: number | null; height: number | null }
type Identity = { id: string; workspaceId: string; channelId: string; version: number; symbol: string; characters: Sheet[]; mark?: { bytes: string; hash: string; width: number; height: number } }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export function getChannelIdentity(workspaceId: string, channelId: string): Identity | null {
  const row = getDb().prepare('SELECT payload_json FROM atm_channel_identities WHERE workspace_id=? AND channel_id=? ORDER BY version DESC LIMIT 1').get(workspaceId, channelId) as { payload_json: string } | undefined
  return row ? JSON.parse(row.payload_json) : null
}

export function resolveChannelIdentity(workspaceId: string, channelId?: string): Identity | null {
  if (channelId) {
    const identity = getChannelIdentity(workspaceId, channelId)
    if (!identity) throw new Error('Simpan identitas karakter channel tujuan sebelum membuat episode.')
    return identity
  }
  const channels = getDb().prepare('SELECT DISTINCT channel_id FROM atm_channel_identities WHERE workspace_id=?').all(workspaceId) as { channel_id: string }[]
  if (channels.length > 1) throw new Error('Pilih channel tujuan untuk mewarisi karakter tetap.')
  return channels.length ? getChannelIdentity(workspaceId, channels[0].channel_id) : null
}

export function publicChannelIdentity(identity: Identity | null) {
  return identity && { ...identity, mark: identity.mark && { hash: identity.mark.hash, width: identity.mark.width, height: identity.mark.height }, characters: identity.characters.map(({ bytes: _bytes, ...c }) => c) }
}

/** Capture actual sheet bytes: editing or deleting the source project cannot change later episodes. */
export function saveChannelIdentity(input: { workspaceId: string; channelId: string; templateProjectId: string; characterIds: string[]; symbol: string; idempotencyKey: string; markDataUrl?: string }) {
  const db = getDb()
  const owned = db.prepare('SELECT project_id FROM atm_productions WHERE project_id=? AND workspace_id=?').get(input.templateProjectId, input.workspaceId)
  if (!owned) throw new Error('Template karakter harus berasal dari ruang ATM yang sama.')
  const cast = charactersOf(input.templateProjectId)
  if (!input.characterIds.length || new Set(input.characterIds).size !== input.characterIds.length) throw new Error('Pilih karakter tetap tanpa duplikat.')
  const characters = input.characterIds.map(id => {
    const c = cast.find(c => c.id === id), sheet = c && getAsset(c.sheetAssetId)
    if (!c || !sheet || sheet.projectId !== input.templateProjectId || sheet.characterId !== c.id) throw new Error('Karakter harus memiliki lembar referensi sendiri.')
    const bytes = readFileSync(assetAbsPath(sheet.projectId, sheet.localPath))
    const extension = extname(sheet.localPath).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension) || !bytes.length || bytes.length > 6 * 1024 * 1024) throw new Error('Lembar karakter tidak valid atau melebihi 6 MB.')
    return { name: c.name, description: c.description, bytes: bytes.toString('base64'), hash: hash(bytes), extension, width: sheet.width, height: sheet.height }
  })
  if (new Set(characters.map(c => c.name.trim().toLowerCase())).size !== characters.length) throw new Error('Nama karakter tetap harus unik.')
  let mark: Identity['mark']
  if (input.markDataUrl) {
    if (!input.markDataUrl.startsWith('data:image/png;base64,')) throw new Error('Simbol channel harus PNG transparan.')
    const bytes = Buffer.from(input.markDataUrl.slice('data:image/png;base64,'.length), 'base64')
    if (bytes.length < 24 || bytes.length > 6 * 1024 * 1024 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('PNG simbol tidak valid.')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (!width || !height || width > 4096 || height > 4096) throw new Error('Ukuran simbol tidak valid.')
    mark = { bytes: bytes.toString('base64'), hash: hash(bytes), width, height }
  }
  const fingerprint = hash(JSON.stringify([input.channelId, input.symbol, characters, mark]))
  return db.transaction(() => {
    const previous = db.prepare('SELECT payload_json,request_hash FROM atm_channel_identities WHERE workspace_id=? AND idempotency_key=?').get(input.workspaceId, input.idempotencyKey) as { payload_json: string; request_hash: string } | undefined
    if (previous) {
      if (previous.request_hash !== fingerprint) throw new Error('Idempotency key identitas sudah dipakai untuk karakter berbeda.')
      return publicChannelIdentity(JSON.parse(previous.payload_json))
    }
    const identity: Identity = { id: randomUUID(), workspaceId: input.workspaceId, channelId: input.channelId, version: (getChannelIdentity(input.workspaceId, input.channelId)?.version ?? 0) + 1, symbol: input.symbol, characters, mark }
    db.prepare('INSERT INTO atm_channel_identities (id,workspace_id,channel_id,version,idempotency_key,request_hash,payload_json) VALUES (?,?,?,?,?,?,?)').run(identity.id, input.workspaceId, input.channelId, identity.version, input.idempotencyKey, fingerprint, JSON.stringify(identity))
    return publicChannelIdentity(identity)
  })()
}

/** Called inside production creation's transaction; every episode owns independent copies. */
export function installChannelIdentity(projectId: string, identity: Identity): IdentitySnapshot {
  const dir = join(projectDir(projectId), 'characters')
  mkdirSync(dir, { recursive: true })
  const characters = identity.characters.map((c, sort) => {
    const bytes = Buffer.from(c.bytes, 'base64')
    if (hash(bytes) !== c.hash) throw new Error('Byte referensi identitas berubah. Produksi dihentikan.')
    const characterId = randomUUID(), localPath = 'characters/' + randomUUID() + c.extension
    writeFileSync(assetAbsPath(projectId, localPath), bytes, { flag: 'wx' })
    getDb().prepare('INSERT INTO characters (id,project_id,name,description,sort) VALUES (?,?,?,?,?)').run(characterId, projectId, c.name, c.description, sort)
    const sheet = insertAsset({ projectId, characterId, kind: 'image', localPath, width: c.width, height: c.height, model: 'channel-identity:' + identity.id })
    setCharacterSheet(characterId, sheet.id)
    return { name: c.name, description: c.description, hash: c.hash, characterId, sheetAssetId: sheet.id }
  })
  let markAssetId: string | undefined
  if (identity.mark) {
    const mark = identity.mark, bytes = Buffer.from(mark.bytes, 'base64')
    if (hash(bytes) !== mark.hash) throw new Error('Byte simbol identitas berubah.')
    const localPath = 'characters/' + randomUUID() + '.png'
    writeFileSync(assetAbsPath(projectId, localPath), bytes, { flag: 'wx' })
    const asset = insertAsset({ projectId, kind: 'overlay', localPath, width: mark.width, height: mark.height, model: 'channel-identity:' + identity.id })
    markAssetId = asset.id
    const editor = getProject(projectId).editor
    editor.overlays = [...editor.overlays, { id: randomUUID(), kind: 'image', assetId: asset.id, anchor: 9, x: 0.965, y: 0.0622, width: 0.055, opacity: 0.85, start: 0, end: null }]
    getDb().prepare('UPDATE projects SET editor_json=? WHERE id=?').run(JSON.stringify(editor), projectId)
  }
  return { id: identity.id, workspaceId: identity.workspaceId, channelId: identity.channelId, version: identity.version, symbol: identity.symbol, characters, markAssetId, markHash: identity.mark?.hash }
}

export function channelIdentityContext(snapshot: IdentitySnapshot | null): string {
  return snapshot ? [
    'CHANNEL CAST SNAPSHOT: reuse these original recurring characters by their exact names, identities and appearances. Create new dilemmas, ordering and endings for them.',
    'Keep permanent identity traits and the channel symbol; scene-specific weather clothing and earned injuries must be explicit continuity changes.',
    'Channel symbol: ' + snapshot.symbol,
    ...snapshot.characters.map(c => c.name + ': ' + c.description)
  ].join('\n') : ''
}
