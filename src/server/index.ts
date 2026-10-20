import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { getDb } from '../main/db'
import { dispatch, registerIpc } from '../main/ipc'
import { eventBus, emit } from '../main/events'
import { assetAbsPath, fontsDir, projectsRoot } from '../main/paths'
import { getProject, insertAsset, patchClip } from '../main/repo'
import { probeDurationMs, probeSize } from '../main/services/audio'
import { buildFlowZip } from '../main/flowExport'

process.env.WEB_MODE = '1'

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''

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
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2'
}

// Ensure DB is initialized and IPC handlers are registered
getDb()
registerIpc()

const sseClients = new Set<ServerResponse>()

// Broadcast domain events to all connected SSE browser clients
function broadcastEvent(channel: string, payload: unknown): void {
  const data = `data: ${JSON.stringify({ channel, payload })}\n\n`
  for (const res of sseClients) {
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
  for (const res of sseClients) {
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
      'Accept-Ranges': 'bytes'
    })
    createReadStream(abs, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  })
  createReadStream(abs).pipe(res)
}

const server = createServer(async (req, res) => {
  // CORS & basic headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  // Auth check if AUTH_TOKEN is set
  if (AUTH_TOKEN) {
    const authHeader = req.headers.authorization
    const token = authHeader?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token')
    if (token !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
  }

  // 1. JSON-RPC API endpoint
  if (req.method === 'POST' && pathname === '/api/rpc') {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const { channel, args } = body
        const result = await dispatch(channel, args || [])
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ result }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? String(err) }))
      }
    })
    return
  }

  // 2. Server-Sent Events endpoint
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    req.on('close', () => {
      sseClients.delete(res)
    })
    return
  }

  // 3. Stored Assets serving (/api/asset/:projectId/...)
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/asset/')) {
    const rel = pathname.slice('/api/asset/'.length)
    const root = normalize(projectsRoot())
    const abs = normalize(join(root, rel))
    if (!abs.startsWith(root + sep)) {
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
    const root = normalize(fontsDir())
    const abs = normalize(join(root, rel))
    if (!abs.startsWith(root + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }
    sendFileWithRange(req, res, abs)
    return
  }

  // 5. File upload for music and overlays (/api/upload)
  if (req.method === 'POST' && pathname === '/api/upload') {
    try {
      const projectId = url.searchParams.get('projectId')
      const kind = url.searchParams.get('kind') // 'music' or 'overlay'
      if (!projectId || !kind) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing projectId or kind' }))
        return
      }

      getProject(projectId)

      // Use native web Request formData parser
      const webReq = new Response(Readable.toWeb(req) as any, {
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
      const folder = kind === 'music' ? 'music' : kind === 'video' ? 'videos' : 'overlays'
      const rel = `${folder}/${randomUUID()}${ext}`
      const abs = assetAbsPath(projectId, rel)

      mkdirSync(join(abs, '..'), { recursive: true })
      const buf = Buffer.from(await file.arrayBuffer())
      writeFileSync(abs, buf)

      let asset
      if (kind === 'music') {
        const durationMs = await probeDurationMs(abs).catch(() => null)
        asset = insertAsset({
          projectId,
          kind: 'music',
          provider: 'local',
          prompt: originalName,
          localPath: rel,
          durationMs
        })
      } else if (kind === 'video') {
        const durationMs = await probeDurationMs(abs).catch(() => null)
        const size = await probeSize(abs).catch(() => null)
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

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ asset }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? String(err) }))
    }
    return
  }

  // 6. Direct MP4 download (/api/download?path=...)
  if (req.method === 'GET' && pathname === '/api/download') {
    const rawPath = url.searchParams.get('path')
    if (!rawPath || !existsSync(rawPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('File not found')
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${basename(rawPath)}"`)
      sendFileWithRange(req, res, rawPath)
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
  let filePath = normalize(join(staticRoot, pathname))

  // Route fallback to index.html for SPA client-side routes
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(staticRoot, 'index.html')
  }

  if (existsSync(filePath)) {
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Bang Story build not found. Run npm run build first.')
})

server.listen(PORT, HOST, () => {
  console.log(`[Bang Story Web] Listening on http://${HOST}:${PORT}`)
})
