// Bang Story Universal Web Bridge for Browser
;(function () {
  if (window.api) return

  const listeners = new Map()

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
    const es = new EventSource('/api/events')
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
    es.onerror = () => {
      // EventSource auto-reconnects
    }
  }

  initEvents()

  async function rpc(channel, ...args) {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })
    const data = await res.json()
    if (!res.ok || data.error) {
      throw new Error(data.error || `RPC error for ${channel}`)
    }
    return data.result
  }

  function pickAndUpload(projectId, kind, accept) {
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
          const res = await fetch(`/api/upload?projectId=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}`, {
            method: 'POST',
            body: formData
          })
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
            pickImage: (projectId) => pickAndUpload(projectId, 'overlay', 'image/*'),
            setActive: (clipId, assetId) => rpc('assets:setActive', clipId, assetId),
            setWords: (assetId, words) => rpc('assets:setWords', assetId, words)
          }
        }

        if (namespace === 'exporter') {
          return {
            start: (projectId, opts) => rpc('export:start', projectId, opts),
            defaultFolder: () => Promise.resolve('exports'),
            pickFolder: () => Promise.resolve('exports'),
            reveal: (path) => {
              const a = document.createElement('a')
              a.href = `/api/download?path=${encodeURIComponent(path)}`
              a.download = path.split(/[\/\\]/).pop() || 'video.mp4'
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              return Promise.resolve()
            }
          }
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
