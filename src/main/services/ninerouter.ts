import type { KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
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
  { id: 'gemini/gemini-3.1-flash-tts-preview', name: 'Gemini 3.1 Flash TTS', desc: 'Google Gemini Flash Voice' },
  { id: 'gemini/gemini-2.5-flash-preview-tts', name: 'Gemini 2.5 Flash TTS', desc: 'Google Gemini 2.5 Voice' },
  { id: 'gemini/gemini-2.5-pro-preview-tts', name: 'Gemini 2.5 Pro TTS', desc: 'Google Gemini Pro Voice' },
  { id: 'openrouter/openai/tts-1', name: 'OpenAI TTS 1', desc: 'OpenAI Natural Voice' },
  { id: 'openrouter/openai/tts-1-hd', name: 'OpenAI TTS 1 HD', desc: 'OpenAI High Definition' },
  { id: 'openrouter/openai/gpt-4o-mini-tts', name: 'GPT-4o Mini TTS', desc: 'OpenRouter TTS' }
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

export async function listVoices(): Promise<VoiceOption[]> {
  const models = await listTtsModels()
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description || '9Router TTS Model'
  }))
}

export async function speak(text: string, voiceOrModel?: string, _languageCode?: string, signal?: AbortSignal): Promise<Buffer> {
  const base = getBaseUrl()
  const key = getKey()
  const model = voiceOrModel || getSettings().nineRouterTtsModel || 'gemini/gemini-3.1-flash-tts-preview'

  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({
      model,
      input: text
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

export async function generateImage(
  prompt: string,
  modelOverride?: string,
  size = '1024x1024',
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const base = getBaseUrl()
  const key = getKey()
  const model = modelOverride || getSettings().nineRouterImageModel || 'ag/gemini-3.1-flash-image'

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size
    }),
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
    if (!dl.ok) throw new Error(`Gagal mengunduh gambar hasil dari ${item.url}`)
    const ab = await dl.arrayBuffer()
    return { bytes: Buffer.from(ab), contentType: dl.headers.get('Content-Type') || 'image/png' }
  }

  throw new Error('Format respon 9Router Image tidak dikenali')
}
