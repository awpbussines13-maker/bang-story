import { execFile } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { binPath } from '../paths'
import type { KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
import { DEFAULT_NINE_ROUTER_IMAGE_MODEL, GEMINI_LIBRARY_VOICES, GEMINI_VOICES, isFluxImageModel } from '@shared/models'
import { getSecret } from '../secrets'
import { getSettings } from '../settings'
import { readError } from './http'

export function getBaseUrl(): string {
  const url = (getSettings().nineRouterBaseUrl || 'http://127.0.0.1:20128/v1').trim().replace(/\/+$/, '')
  return url || 'http://127.0.0.1:20128/v1'
}

export function getKey(): string {
  return getSecret('9router') || process.env.NINEROUTER_KEY || process.env.HERMES_CUSTOM_ROUTER_OPENZ_MY_ID_API_KEY || ''
}

export async function testConnection(baseUrlOverride?: string, keyOverride?: string): Promise<KeyTestResult> {
  const base = (baseUrlOverride ?? getBaseUrl()).trim().replace(/\/+$/, '')
  const key = keyOverride !== undefined ? keyOverride : getKey()
  try {
    const res = await fetch(`${base}/models`, {
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) {
      const err = await readError(res)
      return { ok: false, message: `9Router gagal (${res.status}): ${err}` }
    }
    const data = (await res.json()) as { data?: unknown[] }
    const count = data.data?.length ?? 0
    return { ok: true, message: `Terhubung ke 9Router · ${count} model tersedia` }
  } catch (e) {
    return { ok: false, message: `Tidak bisa terhubung ke ${base}: ${(e as Error).message}` }
  }
}

export async function listModels(): Promise<ModelOption[]> {
  const base = getBaseUrl()
  const key = getKey()
  const res = await fetch(`${base}/models`, {
    headers: {
      Accept: 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) {
    const err = await readError(res)
    throw new Error(`Gagal mengambil model 9Router: ${err}`)
  }
  const data = (await res.json()) as { data?: any[] }
  return (data.data ?? [])
    .filter((m) => m && m.id)
    .map((m): ModelOption => {
      const tags: string[] = []
      if (m.capabilities?.reasoning) tags.push('Reasoning')
      if (m.capabilities?.vision) tags.push('Vision')
      if (m.owned_by) tags.push(m.owned_by)
      return {
        id: m.id,
        name: m.id,
        description: m.context_length ? `Konteks ${(m.context_length / 1000).toFixed(0)}k token` : undefined,
        contextLength: m.context_length ?? null,
        tags
      }
    })
}

export const POPULAR_TTS_MODELS = [
  { id: 'gemini/gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS', desc: 'Google Gemini Flash Voice' },
  { id: 'gemini/gemini-3.1-flash-tts-preview', name: 'Gemini 3.1 Flash TTS', desc: 'Google Gemini Flash Voice' },
  { id: 'gemini/gemini-2.5-flash-preview-tts', name: 'Gemini 2.5 Flash TTS', desc: 'Google Gemini 2.5 Voice' },
  { id: 'gemini/gemini-2.5-pro-preview-tts', name: 'Gemini 2.5 Pro TTS', desc: 'Google Gemini Pro Voice' },
  { id: 'openrouter/openai/tts-1', name: 'OpenAI TTS 1', desc: 'OpenAI Natural Voice' },
  { id: 'openrouter/openai/tts-1-hd', name: 'OpenAI TTS 1 HD', desc: 'OpenAI High Definition' },
  { id: 'openrouter/openai/gpt-4o-mini-tts', name: 'GPT-4o Mini TTS', desc: 'OpenRouter TTS' }
]

const FALLBACK_IMAGE_MODELS: ModelOption[] = [
  {
    id: DEFAULT_NINE_ROUTER_IMAGE_MODEL,
    name: 'FLUX 2 Klein 9B',
    description: 'Cloudflare · Black Forest Labs',
    tags: ['Gambar', 'Cloudflare', 'Rekomendasi']
  },
  { id: 'ag/gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', tags: ['Gambar'] },
  { id: 'dall-e-3', name: 'DALL-E 3', tags: ['Gambar'] },
  { id: 'dall-e-2', name: 'DALL-E 2', tags: ['Gambar'] }
]

export async function listTtsModels(): Promise<ModelOption[]> {
  const base = getBaseUrl()
  const key = getKey()
  try {
    const res = await fetch(`${base}/models/tts`, {
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const data = (await res.json()) as { data?: { id: string }[] }
      if (data.data && data.data.length > 0) {
        return data.data.map((m) => ({
          id: m.id,
          name: m.id,
          tags: ['TTS']
        }))
      }
    }
  } catch {
    // Fall back to static list
  }
  return POPULAR_TTS_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.desc,
    tags: ['TTS']
  }))
}

export async function listImageModels(): Promise<ModelOption[]> {
  const base = getBaseUrl()
  const key = getKey()
  const res = await fetch(`${base}/models/image`, {
    headers: {
      Accept: 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!res.ok) {
    if (res.status === 404) return FALLBACK_IMAGE_MODELS
    const err = await readError(res)
    throw new Error(`Gagal mengambil model gambar 9Router: ${err}`)
  }

  const data = (await res.json()) as {
    data?: { id?: string; name?: string; description?: string; owned_by?: string; tags?: string[] }[]
  }
  const models = (data.data ?? []).flatMap((model): ModelOption[] => {
    if (!model || typeof model.id !== 'string' || !model.id.trim()) return []
    const tags = Array.isArray(model.tags) ? model.tags.filter((tag): tag is string => typeof tag === 'string') : []
    if (!tags.includes('Gambar')) tags.unshift('Gambar')
    if (model.owned_by && !tags.includes(model.owned_by)) tags.push(model.owned_by)
    return [
      {
        id: model.id,
        name: model.name || model.id,
        description: model.description,
        tags
      }
    ]
  })

  if (!models.length) return FALLBACK_IMAGE_MODELS
  const ids = new Set(models.map((model) => model.id))
  return [...models, ...FALLBACK_IMAGE_MODELS.filter((model) => !ids.has(model.id))]
}

export async function listVoices(): Promise<VoiceOption[]> {
  const models = await listTtsModels()
  const selected = getSettings().nineRouterTtsModel || ''
  // Put the configured model first without changing saved model-only selections.
  models.sort((a, b) => Number(selected === b.id || selected.startsWith(b.id + '/')) - Number(selected === a.id || selected.startsWith(a.id + '/')))
  return models.flatMap((m): VoiceOption[] => {
    if (!/^gemini\/gemini-[^/]*tts[^/]*$/.test(m.id)) {
      return [{ id: m.id, name: m.name, description: m.description || '9Router TTS Model' }]
    }
    const group = POPULAR_TTS_MODELS.find((model) => model.id === m.id)?.name || m.name
    // Extended library IDs are supported by 3.8; older models use the classic voices.
    const library = /^gemini\/gemini-3\.8-/.test(m.id) ? GEMINI_LIBRARY_VOICES : []
    const voices = [
      ...library.map((v) => ({ id: v.id, name: v.name, description: v.tone })),
      ...GEMINI_VOICES.map((v) => ({ id: v.id, name: v.id, description: v.tone }))
    ]
    return [
      ...voices.map((v) => ({ ...v, id: `${m.id}/${v.id}`, group })),
      { id: m.id, name: 'Suara bawaan', description: 'Mengikuti suara bawaan model', group }
    ]
  })
}

export async function speak(text: string, voiceOrModel?: string, languageCode?: string, signal?: AbortSignal): Promise<Buffer> {
  const base = getBaseUrl()
  const key = getKey()
  const model = voiceOrModel || getSettings().nineRouterTtsModel || 'gemini/gemini-3.8-flash-tts'

  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({
      model,
      input: text,
      ...(languageCode ? { language: languageCode } : {})
    }),
    signal
  })

  if (!res.ok) {
    const err = await readError(res)
    throw new Error(`9Router TTS gagal (${res.status}): ${err}`)
  }

  const ctype = res.headers.get('Content-Type') || ''
  if (ctype.includes('application/json')) {
    const json = (await res.json()) as { audio?: string }
    if (json.audio) {
      return Buffer.from(json.audio, 'base64')
    }
    throw new Error('9Router TTS tidak mengirim data audio')
  }

  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

// Cloudflare requires reference images smaller than 512x512; keep the entire sheet and its aspect.
async function fluxReference(url: string, signal?: AbortSignal): Promise<string> {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
  if (!match) throw new Error('Gambar referensi Flux tidak valid.')
  const bytes = Buffer.from(match[1], 'base64')
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('Ukuran gambar referensi Flux tidak valid.')
  return new Promise((resolve, reject) => {
    const child = execFile(binPath(ffmpegStatic!), ['-v', 'error', '-i', 'pipe:0', '-vf', "scale=w='min(496,iw)':h='min(496,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 30000, signal, windowsHide: true },
      (error, stdout) => error ? reject(new Error('Gagal menyiapkan gambar referensi Flux.', { cause: error })) : resolve('data:image/png;base64,' + stdout.toString('base64')))
    child.stdin?.on('error', () => {}) // execFile callback reports decoder/abort failures.
    child.stdin?.end(bytes)
  })
}

export async function generateImage(
  prompt: string,
  modelOverride?: string,
  size = '1024x1024',
  signal?: AbortSignal,
  referenceImages?: string[]
): Promise<{ bytes: Buffer; contentType: string }> {
  const base = getBaseUrl()
  const key = getKey()
  const model = modelOverride || getSettings().nineRouterImageModel || DEFAULT_NINE_ROUTER_IMAGE_MODEL
  if (isFluxImageModel(model) && referenceImages?.length) {
    if (referenceImages.length > 4) throw new Error('Flux mendukung maksimal 4 gambar referensi. Kurangi pemeran/acuan gaya atau pilih model lain.')
    referenceImages = await Promise.all(referenceImages.map(url => fluxReference(url, signal)))
  }
  const body =
    isFluxImageModel(model)
      ? {
          model,
          prompt,
          n: 1,
          // FLUX accepts exact dimensions; OpenAI presets are only approximate video ratios.
          size: size === '1792x1024' ? '1792x1008' : size === '1024x1792' ? '1008x1792' : size,
          quality: 'auto',
          background: 'auto',
          image_detail: 'high',
          output_format: 'png'
        }
      : { model, prompt, n: 1, size }

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({ ...body, ...(referenceImages?.length ? { images: referenceImages, output_format: 'png' } : {}) }),
    signal
  })

  if (!res.ok) {
    const err = await readError(res)
    throw new Error(`9Router Image gagal (${res.status}): ${err}`)
  }

  const ctype = res.headers.get('Content-Type') || ''
  if (ctype.includes('image/') || ctype.includes('octet-stream')) {
    const ab = await res.arrayBuffer()
    return { bytes: Buffer.from(ab), contentType: ctype.includes('image/') ? ctype : 'image/png' }
  }

  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
  const item = json.data?.[0]
  if (!item) throw new Error('9Router Image tidak menghasilkan gambar')

  if (item.b64_json) {
    return { bytes: Buffer.from(item.b64_json, 'base64'), contentType: 'image/png' }
  }

  if (item.url) {
    const dl = await fetch(item.url, { signal })
    if (!dl.ok) throw new Error('Gagal mengunduh gambar hasil dari 9Router.')
    const ab = await dl.arrayBuffer()
    return { bytes: Buffer.from(ab), contentType: dl.headers.get('Content-Type') || 'image/png' }
  }

  throw new Error('Format respon 9Router Image tidak dikenali')
}
