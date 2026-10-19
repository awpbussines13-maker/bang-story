import type { KeyStatus, TtsProvider } from '@shared/types'

export const TTS_NAMES: Record<TtsProvider, string> = { gemini: 'Gemini TTS', elevenlabs: 'ElevenLabs', '9router': '9Router TTS' }

/**
 * Whether each narrator voice service can be used: it needs a saved key that did not fail its last check.
 * `reason` says why not, for disabled options.
 */
export function ttsReadiness(keys: KeyStatus[]): Record<TtsProvider, { ok: boolean; reason: string | null }> {
  const one = (p: TtsProvider): { ok: boolean; reason: string | null } => {
    const k = keys.find((x) => x.provider === p)
    const name = p === 'gemini' ? 'Gemini' : p === 'elevenlabs' ? 'ElevenLabs' : '9Router'
    if (!k?.configured) return { ok: false, reason: `Koneksi ${name} belum diatur` }
    if (k.lastOk === false) return { ok: false, reason: `Koneksi ${name} gagal terhubung` }
    return { ok: true, reason: null }
  }
  return { gemini: one('gemini'), elevenlabs: one('elevenlabs'), '9router': one('9router') }
}

/** The preferred provider when it is usable, otherwise another usable one, otherwise the preferred one anyway. */
export function usableTts(preferred: TtsProvider, keys: KeyStatus[]): TtsProvider {
  const ready = ttsReadiness(keys)
  if (ready[preferred]?.ok) return preferred
  const order: TtsProvider[] = ['9router', 'gemini', 'elevenlabs']
  const fallback = order.find((p) => ready[p]?.ok)
  return fallback ?? preferred
}
