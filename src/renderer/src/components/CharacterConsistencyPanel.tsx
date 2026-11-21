import { useEffect, useState } from 'react'
import type { CharacterConsistencyStatus } from '@shared/characterConsistency'
import type { Job } from '@shared/types'
import { Button } from './ui'
import { Select } from './Select'
import { errorText } from '../lib/format'

export function CharacterConsistencyPanel({ projectId, beforeReview, onReadyChange }: { projectId: string; beforeReview?: () => Promise<void>; onReadyChange?: (ready: boolean) => void }) {
  const [status, setStatus] = useState<CharacterConsistencyStatus | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    let mounted = true
    setStatus(null); setJob(null); setError(''); onReadyChange?.(false)
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.consistency.inspect(projectId)
        if (!mounted) return
        setStatus(next); onReadyChange?.(next.ready)
      } catch (e) { if (mounted) { setError(errorText(e)); onReadyChange?.(false) } }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    const unsubscribe = window.api.on.job(next => {
      if (next.projectId !== projectId || next.kind !== 'character-review') return
      setJob(next)
      if (!['queued', 'running'].includes(next.status)) void refresh()
    })
    return () => { mounted = false; clearInterval(timer); unsubscribe() }
  }, [projectId, onReadyChange])

  const run = async (): Promise<void> => {
    setStarting(true); setError('')
    try {
      await beforeReview?.()
      setJob(await window.api.consistency.review(projectId, true, crypto.randomUUID()))
    } catch (e) { setError(errorText(e)) }
    finally { setStarting(false) }
  }
  const running = starting || job?.status === 'running' || job?.status === 'queued'
  const changeStyle = async (assetId: string): Promise<void> => {
    setStarting(true); setError(''); onReadyChange?.(false)
    try {
      await beforeReview?.()
      const next = await window.api.consistency.setStyleReference(projectId, assetId || null)
      setStatus(next); onReadyChange?.(next.ready)
    } catch (e) { setError(errorText(e)) }
    finally { setStarting(false) }
  }
  const blocked = status?.scenes.filter(s => s.status !== 'pass') ?? []
  const manual = status?.scenes.filter(s => s.status === 'best-effort' || s.status === 'manual').length ?? 0
  const styleOptions = [...new Map((status?.scenes ?? []).filter(s => s.assetId).map(s => [s.assetId!, { value: s.assetId!, label: `Adegan ${s.scene}: ${s.title}` }])).values()]
  if (status?.styleReference && !styleOptions.some(o => o.value === status.styleReference!.assetId)) styleOptions.unshift({ value: status.styleReference.assetId, label: 'Acuan gaya tersimpan' })
  return <section aria-label="Pemeriksaan karakter" className="my-4 min-w-0 rounded-xl border border-line bg-sand p-3.5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-bold">Konsistensi karakter &amp; gaya</h4>
        <p role="status" className="mt-1 text-xs leading-5 text-muted">{manual && status?.required === false ? 'Pemeriksaan otomatis nonaktif. Tinjau gambar manual; export tetap tersedia.' : status?.required === false ? 'Pilih acuan gaya untuk memeriksa konsistensi visual project ini.' : status ? `${status.passed}/${status.total} adegan lolos pemeriksaan visual. ${status.ready ? manual ? `${manual} adegan memakai hasil terbaik dan perlu tinjau manual. Export tersedia.` : 'Karakter dan gaya gambar sudah lolos pemeriksaan.' : 'Export ditahan sampai pemeriksaan selesai atau dinonaktifkan di Pengaturan > Umum.'}` : 'Memeriksa status gambar dan referensi…'}</p>
      </div>
      {status?.required && <Button size="sm" loading={running} onClick={() => void run()}>Periksa &amp; perbaiki karakter</Button>}
    </div>
    <p className="mt-2 text-xs leading-5 text-muted">Maksimal tiga percobaan per adegan, lalu pilih hasil terbaik tanpa membuat gambar tambahan. Semua kandidat tetap disimpan. Nonaktifkan pemeriksaan di Pengaturan &gt; Umum untuk meninjau manual tanpa biaya pemeriksaan AI.</p>
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
      {status?.styleReference && <img src={status.styleReference.url} alt="Acuan gaya project" className="h-16 w-28 rounded object-cover" />}
      <div className="min-w-0 flex-1"><Select label="Acuan gaya gambar" value={status?.styleReference?.assetId ?? ''} options={[{ value: '', label: 'Ikuti preset gaya project' }, ...styleOptions]} onChange={value => void changeStyle(value)} disabled={running || !status} size="sm" /></div>
    </div>
    <p className="mt-1 text-xs leading-5 text-muted">Pilih gambar dengan gaya yang kamu inginkan. Gambar acuan dikirim saat generasi dan pemeriksaan. Mengganti acuan mengharuskan pemeriksaan ulang.</p>
    {job?.message && <p className="mt-2 text-xs leading-5">{job.message}</p>}
    {(error || job?.error) && <p role="alert" className="mt-2 break-words text-xs text-bad-ink">{error || job?.error}</p>}
    {!!blocked.length && <details className="mt-2 text-xs"><summary className="cursor-pointer font-semibold">{blocked.length} adegan perlu diperiksa / diperbaiki</summary><ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">{blocked.map(s => <li key={s.clipId} className="break-words"><strong>Adegan {s.scene}: {s.title}</strong><br />{s.reason}</li>)}</ul></details>}
  </section>
}
