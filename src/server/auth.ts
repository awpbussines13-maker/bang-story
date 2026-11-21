import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scrypt = (password: string, salt: Buffer, length: number): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))
})
export const SESSION_COOKIE = 'bang_story_session'
export const REMEMBER_MAX_AGE = 30 * 24 * 60 * 60
export const SESSION_MAX_AGE = 12 * 60 * 60

export interface AuthConfig {
  username: string
  passwordHash: string
  sessionSecret: string
  mcpToken: string
  publicOrigin: string
}

export interface Session {
  username: string
  remember: boolean
  expiresAt: number
}

const revokedSessions = new Map<string, number>()
const revocationFile = join(process.env.DATA_DIR || join(process.cwd(), 'data'), '.revoked-sessions')
let revocationsLoaded = false

function loadRevocations(): void {
  if (revocationsLoaded) return
  try {
    for (const line of readFileSync(revocationFile, 'utf8').split('\n')) {
      const [hash, expiresAt] = line.split(':')
      if (/^[0-9a-f]{64}$/.test(hash) && Number.isSafeInteger(Number(expiresAt))) revokedSessions.set(hash, Number(expiresAt))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  revocationsLoaded = true
}

function persistRevocations(): void {
  const now = Date.now()
  for (const [hash, expiresAt] of revokedSessions) if (expiresAt <= now) revokedSessions.delete(hash)
  const temporary = `${revocationFile}.${process.pid}.tmp`
  const body = [...revokedSessions].map(([hash, expiresAt]) => `${hash}:${expiresAt}`).join('\n')
  writeFileSync(temporary, body ? `${body}\n` : '', { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, revocationFile)
}

const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const config: AuthConfig = {
    username: env.AUTH_USERNAME ?? '',
    passwordHash: env.AUTH_PASSWORD_HASH ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    mcpToken: env.MCP_TOKEN ?? '',
    publicOrigin: env.BANG_STORY_PUBLIC_ORIGIN ?? ''
  }
  if (!config.username || !/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/i.test(config.passwordHash)) {
    throw new Error('Web auth configuration is missing or malformed')
  }
  if (Buffer.byteLength(config.sessionSecret) < 32 || Buffer.byteLength(config.mcpToken) < 32) {
    throw new Error('Web auth secrets must contain at least 32 bytes')
  }
  let origin: URL
  try {
    origin = new URL(config.publicOrigin)
  } catch {
    throw new Error('BANG_STORY_PUBLIC_ORIGIN must be an HTTPS origin')
  }
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin || origin.pathname !== '/') {
    throw new Error('BANG_STORY_PUBLIC_ORIGIN must be an HTTPS origin')
  }
  return config
}

export async function verifyPassword(username: string, password: string, config: Pick<AuthConfig, 'username' | 'passwordHash'>): Promise<boolean> {
  if (!/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/i.test(config.passwordHash)) return false
  const [, saltHex, hashHex] = config.passwordHash.split(':')
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  if (salt.length !== 16 || expected.length !== 64) return false
  const actual = await scrypt(password, salt, expected.length)
  return safeEqual(username, config.username) && timingSafeEqual(actual, expected)
}

export function issueSession(username: string, remember: boolean, secret: string, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + (remember ? REMEMBER_MAX_AGE : SESSION_MAX_AGE)
  const nonce = randomBytes(16).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ username, remember, expiresAt, nonce })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function readSession(token: string | null, secret: string, now = Date.now()): Session | null {
  if (!token) return null
  const nowMs = now
  try { loadRevocations() } catch { return null }
  for (const [revoked, expiresAt] of revokedSessions) if (expiresAt <= nowMs) revokedSessions.delete(revoked)
  if (revokedSessions.has(createHash('sha256').update(token).digest('hex'))) return null
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return null
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  if (!safeEqual(signature, expected)) return null
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Session>
    const maxAge = value.remember ? REMEMBER_MAX_AGE : SESSION_MAX_AGE
    const nowSeconds = Math.floor(now / 1000)
    if (
      typeof value.username !== 'string' ||
      typeof value.remember !== 'boolean' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt! <= nowSeconds ||
      value.expiresAt! > nowSeconds + maxAge
    ) return null
    return { username: value.username, remember: value.remember, expiresAt: value.expiresAt! * 1000 }
  } catch {
    return null
  }
}

export function revokeSession(token: string | null, expiresAt: number): void {
  if (!token) return
  loadRevocations()
  const hash = createHash('sha256').update(token).digest('hex')
  const previous = revokedSessions.get(hash)
  revokedSessions.set(hash, expiresAt)
  try {
    persistRevocations()
  } catch (error) {
    if (previous === undefined) revokedSessions.delete(hash)
    else revokedSessions.set(hash, previous)
    throw error
  }
}

export function sessionCookie(token: string, remember: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? `; Max-Age=${REMEMBER_MAX_AGE}` : ''}`
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function cookieValue(header: string | undefined, name = SESSION_COOKIE): string | null {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null
  }
  return null
}

export function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  return !!actual && safeEqual(actual, expected)
}

export function sameOriginRequest(req: { headers: { origin?: string | string[] } }, publicOrigin: string): boolean {
  const rawOrigin = req.headers.origin
  if (!rawOrigin) return true
  if (Array.isArray(rawOrigin)) return false
  try {
    return new URL(rawOrigin).origin === publicOrigin
  } catch {
    return false
  }
}
