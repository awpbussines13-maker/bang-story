import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'bang-story-auth-test-'))
process.env.DATA_DIR = dataDir
const { issueSession, readSession, sessionCookie, verifyPassword } = await import('../../src/server/auth.ts')
after(() => rmSync(dataDir, { recursive: true, force: true }))

test('verifies only matching username and password; malformed hashes fail closed', async () => {
  const password = 'local-auth-test-password'
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const config = { username: 'owner', passwordHash: `scrypt:${salt.toString('hex')}:${hash.toString('hex')}` }

  assert.equal(await verifyPassword('owner', password, config), true)
  assert.equal(await verifyPassword('other', password, config), false)
  assert.equal(await verifyPassword('owner', 'wrong-password', config), false)
  assert.equal(await verifyPassword('owner', password, { username: 'owner', passwordHash: 'invalid' }), false)
})

test('rejects tampered session signatures', () => {
  const token = issueSession('owner', false, 's'.repeat(48), 0)
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
  assert.equal(readSession(token, 's'.repeat(48), 0)?.username, 'owner')
  assert.equal(readSession(tampered, 's'.repeat(48), 0), null)
})

test('expires unchecked sessions at 12 hours', () => {
  const token = issueSession('owner', false, 's'.repeat(48), 0)
  assert.ok(readSession(token, 's'.repeat(48), 12 * 60 * 60 * 1000 - 1))
  assert.equal(readSession(token, 's'.repeat(48), 12 * 60 * 60 * 1000), null)
})

test('expires remembered sessions at 30 days', () => {
  const token = issueSession('owner', true, 's'.repeat(48), 0)
  assert.ok(readSession(token, 's'.repeat(48), 30 * 24 * 60 * 60 * 1000 - 1))
  assert.equal(readSession(token, 's'.repeat(48), 30 * 24 * 60 * 60 * 1000), null)
})

test('sets persistent cookie flags and keeps unchecked cookie session-only', () => {
  const token = issueSession('owner', true, 's'.repeat(48), 0)
  const persistent = sessionCookie(token, true)
  assert.match(persistent, /; Path=\//)
  assert.match(persistent, /; HttpOnly/)
  assert.match(persistent, /; Secure/)
  assert.match(persistent, /; SameSite=Lax/)
  assert.match(persistent, /; Max-Age=2592000/)
  assert.doesNotMatch(sessionCookie(token, false), /Max-Age=/)
})
