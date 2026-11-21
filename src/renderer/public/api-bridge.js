// Bang Story Universal Web Bridge for Browser
;(function () {
  if (window.api) return

  const listeners = new Map()
  let eventSource = null

  function addListener(event, cb) {
    if (!listeners.has(event)) {
      listeners.set(event, new Set())
    }
    listeners.get(event).add(cb)
    return () => {
      listeners.get(event)?.delete(cb)
    }
  }

  // Connect to Server-Sent Events
  function initEvents() {
    if (eventSource) return
    const es = new EventSource('/api/events')
    eventSource = es
    es.onmessage = (e) => {
      try {
        const { channel, payload } = JSON.parse(e.data)
        const cbs = listeners.get(channel)
        if (cbs) {
          for (const cb of cbs) {
            try {
              cb(payload)
            } catch (err) {
              console.error('[WebBridge Event Callback Error]', err)
            }
          }
        }
      } catch (err) {
        console.error('[WebBridge Parse Error]', err)
      }
    }
    es.onerror = async () => {
      try {
        const response = await fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' })
        const status = response.ok ? await response.json() : null
        if (!status?.authenticated) window.dispatchEvent(new Event('bang-story-auth-expired'))
      } catch {
        // EventSource auto-reconnects during network failures.
      }
    }
  }

  window.addEventListener('bang-story-authenticated', initEvents)
  window.addEventListener('bang-story-logout', () => {
    eventSource?.close()
    eventSource = null
  })

  async function rpc(channel, ...args) {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })

    if (res.status === 401) {
      window.dispatchEvent(new Event('bang-story-auth-expired'))
      throw new Error('Sesi berakhir. Masuk lagi untuk melanjutkan.')
    }

    // Never call res.json() blindly: when a proxy/CDN (Cloudflare 524) or a cold
    // restart answers with an HTML page, res.json() throws the useless
    // `Unexpected token '<', "<!DOCTYPE"... is not valid JSON`. Read the text and
    // turn that case into a message the user can actually act on.
    const raw = await res.text()
    let data
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      const html = raw.trimStart().startsWith('<')
      if (html) {
        throw new Error(
          res.status === 524 || res.status === 504
            ? `Server terlalu lama memproses "${channel}" (timeout ${res.status}). Coba lagi — proses biasanya lanjut di latar belakang.`
            : `Server membalas halaman HTML, bukan data (HTTP ${res.status}). Biasanya server sedang restart atau diblokir proxy. Muat ulang halaman lalu coba lagi.`
        )
      }
      throw new Error(`Balasan server tidak bisa dibaca untuk "${channel}" (HTTP ${res.status}).`)
    }

    if (!res.ok || data.error) {
      throw new Error(data.error || `RPC error for ${channel}`)
    }
    return data.result
  }

  function pickAndUpload(projectId, kind, accept, clipId) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.style.display = 'none'
      document.body.appendChild(input)

      input.onchange = async () => {
        try {
          const file = input.files && input.files[0]
          if (!file) {
            resolve(null)
            return
          }
          const formData = new FormData()
          formData.append('file', file)
          const qs = new URLSearchParams({ projectId, kind })
          if (clipId) qs.set('clipId', clipId)
          const res = await fetch(`/api/upload?${qs.toString()}`, {
            method: 'POST',
            body: formData
          })
          if (res.status === 401) {
            window.dispatchEvent(new Event('bang-story-auth-expired'))
            throw new Error('Sesi berakhir. Masuk lagi untuk melanjutkan.')
          }
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Upload gagal' }))
            throw new Error(err.error || 'Upload gagal')
          }
          const data = await res.json()
          resolve(data.asset)
        } catch (err) {
          reject(err)
        } finally {
          document.body.removeChild(input)
        }
      }

      input.oncancel = () => {
        document.body.removeChild(input)
        resolve(null)
      }

      input.click()
    })
  }

  const api = new Proxy(
    {},
    {
      get: (_, namespace) => {
        if (namespace === 'on') {
          return {
            job: (cb) => addListener('event:job', cb),
            clip: (cb) => addListener('event:clip', cb),
            character: (cb) => addListener('event:character', cb),
            asset: (cb) => addListener('event:asset', cb),
            whisper: (cb) => addListener('event:whisper', cb)
          }
        }

        if (namespace === 'assets') {
          return {
            pickMusic: (projectId) => pickAndUpload(projectId, 'music', 'audio/*'),
            pickSfx: (projectId) => pickAndUpload(projectId, 'sfx', 'audio/*'),
            pickImage: (projectId) => pickAndUpload(projectId, 'overlay', 'image/*'),
            pickVideo: (projectId, clipId) => pickAndUpload(projectId, 'video', 'video/mp4,video/webm,video/quicktime', clipId),
            setActive: (clipId, assetId) => rpc('assets:setActive', clipId, assetId),
            setWords: (assetId, words) => rpc('assets:setWords', assetId, words)
          }
        }

        if (namespace === 'flowImages') {
          async function upload(action, projectId, body, target = '', fit = '') {
            const qs = new URLSearchParams({ action, projectId, target, fit })
            const res = await fetch(`/api/flow-image?${qs}`, { method: 'POST', body })
            if (res.status === 401) window.dispatchEvent(new Event('bang-story-auth-expired'))
            const data = await res.json().catch(() => ({}))
            if (!res.ok || data.error) throw new Error(data.error || `Unggahan gagal (HTTP ${res.status}).`)
            return data.result
          }
          return {
            exportSummary: (projectId) => rpc('flowImages:exportSummary', projectId),
            exportZip: async (projectId, confirmed) => {
              const res = await fetch(`/api/export-flow-v2?${new URLSearchParams({ projectId, confirmed })}`)
              if (res.status === 401) window.dispatchEvent(new Event('bang-story-auth-expired'))
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ekspor ZIP gagal.')
              const url = URL.createObjectURL(await res.blob())
              const a = document.createElement('a')
              a.href = url
              const name = res.headers.get('content-disposition')?.split("filename*=UTF-8''")[1]
              a.download = name ? decodeURIComponent(name) : 'proyek-flow-export.zip'
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 60000)
            },
            reference: (projectId, characterId, bytes) => bytes === null ? rpc('flowImages:reference', projectId, characterId, null) : upload('reference', projectId, bytes, characterId),
            importImage: (projectId, clipId, bytes, fit) => upload('scene', projectId, bytes, clipId, fit),
            importUrl: (...args) => rpc('flowImages:importUrl', ...args),
            changeImage: (...args) => rpc('flowImages:changeImage', ...args),
            previewZip: (projectId, bytes) => upload('zip', projectId, bytes),
            applyZip: (...args) => rpc('flowImages:applyZip', ...args)
          }
        }

        if (namespace === 'exporter') {
          const overrides = {
            start: (projectId, opts) => rpc('export:start', projectId, opts),
            defaultFolder: () => rpc('export:defaultFolder'),
            pickFolder: () => rpc('export:defaultFolder'),
            flowData: (projectId) => rpc('export:flowData', projectId),
            downloadProject: (projectId) => {
              const a = document.createElement('a')
              a.href = `/api/download-project?projectId=${encodeURIComponent(projectId)}`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              return Promise.resolve()
            },
          }
          return new Proxy(overrides, {
            get: (target, prop) => {
              if (prop in target) return target[prop]
              return (...args) => rpc(`export:${String(prop)}`, ...args)
            }
          })
        }

        if (namespace === 'app') {
          return {
            version: () => Promise.resolve('1.0.0-web'),
            copyText: (text) => (navigator.clipboard ? navigator.clipboard.writeText(String(text)) : Promise.resolve()),
            openExternal: (url) => {
              window.open(url, '_blank')
              return Promise.resolve()
            }
          }
        }

        return new Proxy(
          {},
          {
            get: (_, method) => {
              return (...args) => rpc(`${String(namespace)}:${String(method)}`, ...args)
            }
          }
        )
      }
    }
  )

  window.api = api
  console.log('[Bang Story] Web RPC bridge initialized.')
})()
