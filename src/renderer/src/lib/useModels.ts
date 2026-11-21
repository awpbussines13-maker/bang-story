import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelList, ModelSource } from '@shared/types'
import { errorText } from './format'

const memory = new Map<string, ModelList>()

/** Live model list for a provider. Loads from the app's cache first; `refresh()` asks the provider again. */
export function useModels(source: ModelSource, enabled: boolean, scope = '') {
  const key = `${source}|${scope}`
  const [list, setList] = useState<ModelList | null>(memory.get(key) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const load = useCallback(
    async (refresh: boolean): Promise<ModelList | null> => {
      if (!enabled) return null
      const currentRequest = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const l = await window.api.models.list(source, refresh)
        if (currentRequest !== requestId.current) return l
        memory.set(key, l)
        setList(l)
        return l
      } catch (e) {
        if (currentRequest === requestId.current) setError(errorText(e))
        return null
      } finally {
        if (currentRequest === requestId.current) setLoading(false)
      }
    },
    [source, enabled, key]
  )

  useEffect(() => {
    setList(memory.get(key) ?? null)
    setError(null)
    setLoading(false)
    if (enabled) void load(false)
    return () => {
      requestId.current++
    }
  }, [key, enabled, load])

  return {
    models: list?.models ?? [],
    fetchedAt: list?.fetchedAt ?? null,
    loading,
    error,
    refresh: () => load(true)
  }
}
