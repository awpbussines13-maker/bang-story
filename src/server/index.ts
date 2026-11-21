import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb } from '../main/db'
import { dispatch, registerIpc } from '../main/ipc'
import { eventBus, emit } from '../main/events'
import { assetAbsPath, fontsDir, projectsRoot } from '../main/paths'
import { getClip, getLatestExportPath, getProject, insertAsset, patchClip } from '../main/repo'
import { resumeJobs, setActiveAsset } from '../main/generation'
import { probeDurationMs, probeSize } from '../main/services/audio'
import { buildFlowZip } from '../main/flowExport'
import { buildFlowV2Zip, importFlowImage, previewFlowZip, setFlowReference } from '../main/flowV2'
import { FLOW_IMAGE_LIMIT, FLOW_ZIP_LIMIT } from '@shared/flowV2'
import { assertLatestExportCharacterApproval } from '../main/characterConsistency'
import { cookieValue, expiredSessionCookie, issueSession, loadAuthConfig, readSession, revokeSession, safeTokenEqual, sameOriginRequest, sessionCookie, verifyPassword } from './auth'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createBangStoryMcp } from './mcp'

process.env.WEB_MODE = '1'

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'
const AUTH = loadAuthConfig(process.env)
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
const MAX_AUTH_BODY_BYTES = 8 * 1024
const MAX_MCP_BODY_BYTES = 1024 * 1024

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2'
}

const UPLOAD_EXTENSIONS: Record<string, readonly string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  audio: ['.wav', '.mp3', '.m4a', '.ogg'],
  music: ['.wav', '.mp3', '.m4a', '.ogg'],
  sfx: ['.wav', '.mp3', '.m4a', '.ogg'],
  video: ['.mp4', '.mov', '.webm', '.mkv'],
  overlay: ['.png', '.jpg', '.jpeg', '.webp']
}

// Ensure DB is initialized and IPC handlers are registered
getDb()
registerIpc()
resumeJobs()

const sseClients = new Map<ServerResponse, { expiresAt: number; token: string }>()

const loginAttempts = new Map<string, { count: number; blockedUntil: number; inFlight: number }>()

function sessionFor(req: IncomingMessage) {
  const token = cookieValue(req.headers.cookie)
  const session = readSession(token, AUTH.sessionSecret)
  return session?.username === AUTH.username ? { ...session, token: token! } : null
}

function clientAddress(req: IncomingMessage): string {
  const realIp = req.headers['x-real-ip']
  return (typeof realIp === 'string' ? realIp : req.socket.remoteAddress) || 'unknown'
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      const part = Buffer.from(chunk)
      size += part.length
      if (size > maxBytes) {
        if (!tooLarge) reject(new Error('Request body too large'))
        tooLarge = true
        return
      }
      if (!tooLarge) chunks.push(part)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function mcpAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null
  return safeTokenEqual(match?.[1], AUTH.mcpToken)
}

// Broadcast domain events to all connected SSE browser clients
function broadcastEvent(channel: string, payload: unknown): void {
  const data = `data: ${JSON.stringify({ channel, payload })}\n\n`
  for (const [res, session] of sseClients) {
    if (session.expiresAt <= Date.now()) {
      sseClients.delete(res)
      res.end()
      continue
    }
    try {
      res.write(data)
    } catch {
      sseClients.delete(res)
    }
  }
}

eventBus.on('event:job', (p) => broadcastEvent('event:job', p))
eventBus.on('event:clip', (p) => broadcastEvent('event:clip', p))
eventBus.on('event:character', (p) => broadcastEvent('event:character', p))
eventBus.on('event:asset', (p) => broadcastEvent('event:asset', p))
eventBus.on('event:whisper', (p) => broadcastEvent('event:whisper', p))

// Keepalive pings for SSE
setInterval(() => {
  for (const [res, session] of sseClients) {
    if (session.expiresAt <= Date.now()) {
      sseClients.delete(res)
      res.end()
      continue
    }
    try {
      res.write(': ping\n\n')
    } catch {
      sseClients.delete(res)
    }
  }
}, 15000)

function sendFileWithRange(req: IncomingMessage, res: ServerResponse, abs: string): void {
  let size: number
  try {
    size = statSync(abs).size
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  const type = MIME_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  const range = req.headers.range
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null

  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10))
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff'
    })
    createReadStream(abs, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  })
  createReadStream(abs).pipe(res)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    sendJson(res, 400, { error: 'Invalid request path' })
    return
  }

  if (req.method === 'GET' && pathname === '/api/auth/status') {
    const session = sessionFor(req)
    sendJson(res, 200, { enabled: true, authenticated: !!session, remember: session?.remember ?? false })
    return
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!sameOriginRequest(req, AUTH.publicOrigin)) {
      sendJson(res, 403, { error: 'Origin not allowed' })
      return
    }
    const address = clientAddress(req)
    try {
      const body = JSON.parse((await readRequestBody(req, MAX_AUTH_BODY_BYTES)).toString('utf8')) as { username?: unknown; password?: unknown; remember?: unknown }
      if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1000) {
        sendJson(res, 400, { error: 'Nama pengguna dan password wajib diisi.' })
        return
      }
      const current = loginAttempts.get(address)
      if (current && current.blockedUntil > Date.now()) {
        res.setHeader('Retry-After', String(Math.ceil((current.blockedUntil - Date.now()) / 1000)))
        sendJson(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' })
        return
      }
      if (current && current.inFlight >= 2) {
        res.setHeader('Retry-After', '1')
        sendJson(res, 429, { error: 'Login sedang diperiksa. Coba lagi sebentar.' })
        return
      }
      const attempt = current ?? { count: 0, blockedUntil: 0, inFlight: 0 }
      attempt.inFlight++
      loginAttempts.set(address, attempt)
      let valid: boolean
      try {
        valid = await verifyPassword(body.username, body.password, AUTH)
      } catch {
        attempt.inFlight--
        if (!attempt.inFlight && !attempt.count && !attempt.blockedUntil) loginAttempts.delete(address)
        sendJson(res, 503, { error: 'Login sementara tidak tersedia. Coba lagi.' })
        return
      }
      attempt.inFlight--
      if (!valid) {
        if (attempt.blockedUntil <= Date.now()) {
          attempt.count++
          attempt.blockedUntil = attempt.count >= 10 ? Date.now() + 15 * 60 * 1000 : 0
          if (attempt.blockedUntil) attempt.count = 0
        }
        if (loginAttempts.size > 1000) {
          for (const [ip, entry] of loginAttempts) if (!entry.inFlight && entry.blockedUntil && entry.blockedUntil <= Date.now()) loginAttempts.delete(ip)
          if (loginAttempts.size > 1000) {
            const idle = [...loginAttempts].find(([, entry]) => !entry.inFlight)?.[0]
            if (idle) loginAttempts.delete(idle)
          }
        }
        sendJson(res, 401, { error: 'Nama pengguna atau password salah.' })
        return
      }
      attempt.count = 0
      attempt.blockedUntil = 0
      if (!attempt.inFlight) loginAttempts.delete(address)
      const remember = body.remember === true
      const token = issueSession(AUTH.username, remember, AUTH.sessionSecret)
      res.setHeader('Set-Cookie', sessionCookie(token, remember))
      sendJson(res, 200, { authenticated: true, remember })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error && error.message === 'Request body too large' ? 'Request body too large' : 'Permintaan login tidak valid.' })
    }
    return
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (!sameOriginRequest(req, AUTH.publicOrigin)) {
      sendJson(res, 403, { error: 'Origin not allowed' })
      return
    }
    const session = sessionFor(req)
    if (session) {
      try {
        revokeSession(session.token, session.expiresAt)
      } catch {
        sendJson(res, 503, { error: 'Logout could not be saved. Try again.' })
        return
      }
      for (const [client, info] of sseClients) if (info.token === session.token) {
        sseClients.delete(client)
        client.end()
      }
    }
    res.setHeader('Set-Cookie', expiredSessionCookie())
    sendJson(res, 200, { authenticated: false, loggedOut: true })
    return
  }

  if (pathname === '/mcp') {
    if (!mcpAuthorized(req)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }
    try {
      const body = JSON.parse((await readRequestBody(req, MAX_MCP_BODY_BYTES)).toString('utf8'))
      const mcp = createBangStoryMcp({ token: AUTH.mcpToken, port: PORT, publicOrigin: AUTH.publicOrigin })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcp.connect(transport)
      try {
        await transport.handleRequest(req, res, body)
      } finally {
        await mcp.close()
      }
    } catch (error) {
      if (!res.headersSent) sendJson(res, error instanceof Error && error.message === 'Request body too large' ? 413 : 400, { error: 'MCP request could not be processed' })
      else if (!res.writableEnded) res.end()
    }
    return
  }

  const session = sessionFor(req)
  const bearer = mcpAuthorized(req)
  const mcpDataRoute = bearer && (
    pathname === '/api/upload' ||
    pathname === '/api/download-project' ||
    pathname === '/api/export-flow' ||
    pathname.startsWith('/api/asset/') ||
    pathname.startsWith('/api/fonts/')
  )
  if (pathname.startsWith('/api/') && !session && !mcpDataRoute) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') && session && !sameOriginRequest(req, AUTH.publicOrigin)) {
    sendJson(res, 403, { error: 'Origin not allowed' })
    return
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, POST')
    res.writeHead(405)
    res.end()
    return
  }

  if (req.method === 'POST' && pathname === '/api/flow-image') {
    const projectId = url.searchParams.get('projectId') ?? ''
    const action = url.searchParams.get('action')
    try {
      if (action !== 'zip' && action !== 'reference' && action !== 'scene') throw new Error('Jenis impor tidak dikenal.')
      const bytes = await readRequestBody(req, action === 'zip' ? FLOW_ZIP_LIMIT : FLOW_IMAGE_LIMIT)
      const target = url.searchParams.get('target') ?? ''
      const result = action === 'zip' ? await previewFlowZip(projectId, bytes)
        : action === 'reference' ? await setFlowReference(projectId, target, bytes)
          : await importFlowImage(projectId, target, bytes, url.searchParams.get('fit'))
      sendJson(res, 200, { result })
    } catch (err) {
      const message = (err as Error).message
      sendJson(res, message === 'Request body too large' ? 413 : 400, { error: message === 'Request body too large' ? 'Ukuran file melebihi batas unggahan.' : message })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/export-flow-v2') {
    try {
      const { fileName, zipBuffer } = await buildFlowV2Zip(url.searchParams.get('projectId') ?? '', url.searchParams.get('confirmed') === 'true')
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
        'Content-Length': zipBuffer.length,
        'Cache-Control': 'no-store'
      })
      res.end(zipBuffer)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // 1. JSON-RPC API endpoint
  if (req.method === 'POST' && pathname === '/api/rpc') {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      // Some handlers (AI script/visual generation, export) can run for minutes.
      // Cloudflare cuts the origin connection after 100s and replaces the body
      // with its own HTML error page, which the browser then reported as
      // `Unexpected token '<', "<!DOCTYPE"... is not valid JSON`.
      // Sending the headers immediately and flushing a space every 10s keeps the
      // stream alive through proxies; leading whitespace is still valid JSON for
      // the client, so the payload below is parsed normally.
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      })
      // Push the headers out now instead of waiting for the first body write,
      // so the client sees an open 200 immediately even on slow handlers.
      res.flushHeaders?.()

      const keepAlive = setInterval(() => {
        try {
          res.write(' ')
        } catch {
          /* client already gone */
        }
      }, 10000)

      let payload: string
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const { channel, args } = body
        const result = await dispatch(channel, args || [])
        payload = JSON.stringify({ result })
      } catch (err) {
        payload = JSON.stringify({ error: (err as Error)?.message ?? String(err) })
      } finally {
        clearInterval(keepAlive)
      }

      res.end(payload)
    })
    return
  }

  // 2. Server-Sent Events endpoint
  if (req.method === 'GET' && pathname === '/api/events') {
    if (!session) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    sseClients.set(res, { expiresAt: session.expiresAt, token: session.token })
    req.on('close', () => {
      sseClients.delete(res)
    })
    return
  }

  // 3. Stored Assets serving (/api/asset/:projectId/...)
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/asset/')) {
    const rel = pathname.slice('/api/asset/'.length)
    const root = resolve(projectsRoot())
    const candidate = resolve(root, rel)
    if (!candidate.startsWith(root + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }
    let abs: string
    try { abs = realpathSync(candidate) } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    if (!abs.startsWith(realpathSync(root) + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }
    sendFileWithRange(req, res, abs)
    return
  }

  // 4. Caption Fonts serving (/api/fonts/:font.ttf)
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/fonts/')) {
    const rel = pathname.slice('/api/fonts/'.length)
    const root = resolve(fontsDir())
    const candidate = resolve(root, rel)
    if (!candidate.startsWith(root + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }
    let abs: string
    try { abs = realpathSync(candidate) } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    if (!abs.startsWith(realpathSync(root) + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }
    sendFileWithRange(req, res, abs)
    return
  }

  // 5. File upload for music and overlays (/api/upload)
  if (req.method === 'POST' && pathname === '/api/upload') {
    let createdFile: string | null = null
    try {
      const projectId = url.searchParams.get('projectId')
      const kind = url.searchParams.get('kind')
      const clipId = url.searchParams.get('clipId')
      if (!projectId || !kind) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing projectId or kind' }))
        return
      }
      if (!['music', 'sfx', 'video', 'overlay', 'image', 'audio'].includes(kind)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unsupported upload kind' }))
        return
      }
      if ((kind === 'image' || kind === 'audio') && !clipId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'clipId is required for image and audio uploads' }))
        return
      }

      getProject(projectId)
      if (clipId) {
        if (getClip(clipId).projectId !== projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Clip does not belong to this project' }))
          return
        }
      }

      const contentLength = Number(req.headers['content-length'] || 0)
      if (contentLength > MAX_UPLOAD_BYTES + 64 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Upload exceeds 32 MiB' }))
        return
      }
      const chunks: Buffer[] = []
      let bodyBytes = 0
      for await (const chunk of req) {
        const part = Buffer.from(chunk)
        bodyBytes += part.length
        if (bodyBytes > MAX_UPLOAD_BYTES + 64 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Upload exceeds 32 MiB' }))
          return
        }
        chunks.push(part)
      }

      // Parse only a bounded body so chunked uploads cannot bypass the size limit.
      const webReq = new Response(Buffer.concat(chunks), {
        headers: req.headers as any
      })
      const form = await webReq.formData()
      const file = form.get('file') as File | null
      if (!file) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No file uploaded' }))
        return
      }

      const originalName = file.name || 'uploaded_file'
      const ext = extname(originalName).toLowerCase()
      if (file.size > MAX_UPLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'File exceeds 32 MiB' }))
        return
      }
      if (!UPLOAD_EXTENSIONS[kind]?.includes(ext)) {
        res.writeHead(415, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unsupported ${kind} file type` }))
        return
      }
      const folder = kind === 'sfx' ? 'sfx' : kind === 'music' ? 'music' : kind === 'video' ? 'videos' : kind === 'image' ? 'images' : kind === 'audio' ? 'audio' : 'overlays'
      const rel = `${folder}/${randomUUID()}${ext}`
      const abs = assetAbsPath(projectId, rel)

      mkdirSync(join(abs, '..'), { recursive: true })
      const buf = Buffer.from(await file.arrayBuffer())
      writeFileSync(abs, buf)
      createdFile = abs

      let asset
      if (kind === 'image') {
        const size = await probeSize(abs).catch(() => null)
        if (!size) throw new Error('Gambar tidak bisa dibaca. Pakai PNG, JPG, atau WebP.')
        asset = insertAsset({
          projectId,
          clipId,
          kind: 'image',
          provider: 'local',
          prompt: originalName,
          localPath: rel,
          width: size.width,
          height: size.height
        })
        await setActiveAsset(clipId!, asset.id)
      } else if (kind === 'audio') {
        const durationMs = await probeDurationMs(abs).catch(() => null)
        if (!durationMs) throw new Error('Durasi suara tidak bisa dibaca. Pakai WAV, MP3, M4A, atau OGG.')
        asset = insertAsset({
          projectId,
          clipId,
          kind: 'audio',
          provider: 'local',
          prompt: originalName,
          localPath: rel,
          durationMs
        })
        await setActiveAsset(clipId!, asset.id)
      } else if (kind === 'music' || kind === 'sfx') {
        const durationMs = await probeDurationMs(abs).catch(() => null)
        if (!durationMs) throw new Error('Durasi musik tidak bisa dibaca. Pakai WAV, MP3, M4A, atau OGG.')
        asset = insertAsset({
          projectId,
          kind,
          provider: 'local',
          prompt: originalName,
          localPath: rel,
          durationMs
        })
      } else if (kind === 'video') {
        const durationMs = await probeDurationMs(abs).catch(() => null)
        const size = await probeSize(abs).catch(() => null)
        if (!durationMs || !size) throw new Error('Video tidak bisa dibaca. Pakai MP4, MOV, WebM, atau MKV.')
        const clipId = url.searchParams.get('clipId') || null
        asset = insertAsset({
          projectId,
          clipId,
          kind: 'video',
          provider: 'local',
          prompt: originalName,
          localPath: rel,
          durationMs,
          width: size?.width,
          height: size?.height
        })
        if (clipId) {
          patchClip(clipId, {
            videoAssetId: asset.id,
            motionType: 'video',
            mediaInMs: 0
          })
          emit.clip({ clipId, patch: { videoAssetId: asset.id, motionType: 'video', mediaInMs: 0 } })
        }
      } else {
        if (kind !== 'overlay') throw new Error('Video uploads require the existing clip video flow')
        const size = await probeSize(abs).catch(() => null)
        if (!size) throw new Error('Gambar tidak bisa dibaca. Pakai PNG, JPG, atau WebP.')
        asset = insertAsset({
          projectId,
          kind: 'overlay',
          provider: 'local',
          prompt: originalName,
          localPath: rel,
          width: size.width,
          height: size.height
        })
      }

      createdFile = null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ asset }))
    } catch (err) {
      if (createdFile) rmSync(createdFile, { force: true })
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? String(err) }))
    }
    return
  }

  // Old arbitrary-path download route is intentionally disabled.
  if (pathname === '/api/download') {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  // Download the latest completed export for one project without accepting a filesystem path.
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/download-project') {
    const projectId = url.searchParams.get('projectId')
    try { if (projectId) assertLatestExportCharacterApproval(projectId) }
    catch (e) { sendJson(res, 409, { error: (e as Error).message }); return }
    const exportPath = projectId ? getLatestExportPath(projectId) : null
    if (!exportPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Export not found')
    } else {
      const fileName = basename(exportPath).replace(/[\r\n"]/g, '_')
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      sendFileWithRange(req, res, exportPath)
    }
    return
  }

  // 6b. Google Flow automation export package (/api/export-flow?projectId=...)
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/export-flow') {
    try {
      const projectId = url.searchParams.get('projectId')
      if (!projectId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing projectId' }))
        return
      }

      const { zipBuffer, fileName } = buildFlowZip(projectId)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'Content-Length': String(zipBuffer.length),
        'Cache-Control': 'no-cache'
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(zipBuffer)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? String(err) }))
    }
    return
  }

  // 7. Static file serving from Vite build directory (`out/renderer`)
  const staticRoot = join(__dirname, 'renderer')
  let filePath = resolve(staticRoot, `.${pathname}`)
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  // Route fallback to index.html for SPA client-side routes
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(staticRoot, 'index.html')
  }

  if (existsSync(filePath)) {
    const realStaticRoot = realpathSync(staticRoot)
    const realFilePath = realpathSync(filePath)
    if (!realFilePath.startsWith(realStaticRoot + sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    filePath = realFilePath
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const isNoCache = filePath.endsWith('index.html') || filePath.includes('api-bridge')
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': isNoCache ? 'no-store, no-cache, must-revalidate, max-age=0' : 'no-cache',
      ...(isNoCache ? { Pragma: 'no-cache', Expires: '0' } : {})
    })
    createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Bang Story build not found. Run npm run build first.')
})

server.listen(PORT, HOST, () => {
  console.log(`[Bang Story Web] Listening on http://${HOST}:${PORT}`)
})
