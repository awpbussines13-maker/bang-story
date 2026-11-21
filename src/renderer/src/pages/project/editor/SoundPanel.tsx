import { useState } from 'react'
import { SFX_PRESETS, soundPlanStale } from '@shared/soundDesign'
import type { SfxCue, SfxPreset } from '@shared/types'
import { Select } from '../../../components/Select'
import { Button, Switch, inputCls } from '../../../components/ui'
import { errorText } from '../../../lib/format'
import { waitForStudioJob } from '../../../lib/audioJobs'
import { useApp } from '../../../store/app'
import { isRunning, useProject } from '../../../store/project'
import { removeSfxCue, updateSfxCue, usePlayback, useSfxUi } from './engine'

export function SoundPanel() {
  const { project, clips, assets, jobs, selectedClipId, updateEditor, flush, load, addAsset } = useProject()
  const selectedId = useSfxUi(s => s.selectedId), select = useSfxUi(s => s.select)
  const [busy, setBusy] = useState(false), [source, setSource] = useState(''), [license, setLicense] = useState('')
  const { toast } = useApp()
  if (!project) return null
  const sound = project.editor.soundDesign ?? { enabled: false, cues: [] }
  const cue = sound.cues.find(c => c.id === selectedId)
  const clip = clips.find(c => c.id === (cue?.clipId ?? selectedClipId)) ?? clips[0]
  const running = busy || Object.values(jobs).some(j => j.kind === 'sound-plan' && isRunning(j))
  const sources = Object.values(assets).filter(a => a.kind === 'sfx')
  const selectedAsset = cue?.assetId ? assets[cue.assetId] : null
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await fn() } catch (e) { toast('error', errorText(e)) } finally { setBusy(false) }
  }
  const add = (): void => {
    if (!clip) return
    const next: SfxCue = { id: crypto.randomUUID(), clipId: clip.id, label: 'Impact', assetId: null, preset: 'impact',
      startMs: 0, durationMs: Math.min(800, clip.durationMs), inMs: 0, gainDb: -15,
      fadeInMs: Math.min(5, Math.floor(clip.durationMs/2)), fadeOutMs: Math.min(60, Math.floor(clip.durationMs / 2)), muted: false, manual: true, bed: false }
    updateEditor({ soundDesign: { ...sound, enabled: true, cues: [...sound.cues, next] } }); select(next.id)
  }
  const num = (label: string, value: number, onChange: (v: number) => void, min: number, max: number, step = 1) => (
    <label className="flex flex-col gap-1 text-xs">{label}<input aria-label={label} className={inputCls} type="number" min={min} max={max} step={step} value={value}
      onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) onChange(Math.max(min, Math.min(max, e.target.valueAsNumber))) }} /></label>
  )
  return <div className="flex flex-col gap-4 p-[18px]">
    <h2 className="text-sm font-semibold">Efek suara</h2>
    <Switch on={sound.enabled} onChange={enabled => updateEditor({ soundDesign: { ...sound, enabled } })} label="Aktifkan SFX" />
    <p className="text-xs text-muted">Efek mengikuti kejadian dan suasana cerita. Musik dan ambience turun saat narasi.</p>
    <Button disabled={running || !clips.length} onClick={() => void run(async () => {
      usePlayback.getState().pause(); await flush()
      const revision = JSON.stringify(useProject.getState().project?.editor.soundDesign)
      const { bundle: result } = await waitForStudioJob(project.id, () => window.api.sound.plan(project.id, crypto.randomUUID()))
      if (useProject.getState().saveState !== 'saved' || JSON.stringify(useProject.getState().project?.editor.soundDesign) !== revision) {
        toast('error', 'Ada edit baru. Muat ulang proyek untuk meninjau hasil SFX tersimpan.'); return
      }
      load(result)
    })}>{running ? 'Menyusun SFX…' : 'Susun otomatis'}</Button>
    <p className="text-xs text-muted">Penyusunan memakai model cerita yang dipilih; biaya mengikuti providernya. Sintesis dan mixing dikerjakan lokal. Cue manual dipertahankan.</p>
    {soundPlanStale(clips, project.editor, Object.values(assets)) && <p role="alert" className="text-xs text-bad-ink">Cerita atau timing berubah. Susun ulang SFX sebelum preview/ekspor, atau matikan SFX.</p>}
    {sound.warnings?.map((warning,i) => <p key={i} className="text-xs text-muted">{warning}</p>)}
    <Button variant="secondary" disabled={!clip} onClick={add}>Tambah efek di adegan terpilih</Button>
    <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
      const asset = await window.api.assets.pickSfx(project.id)
      if (asset) { addAsset(asset); toast('success', 'Aset SFX ditambahkan. Pilih di sumber efek dan isi lisensinya.') }
    })}>Upload SFX</Button>
    <div className="flex flex-col gap-1" aria-label="Daftar efek suara">
      {sound.cues.map(c => <button key={c.id} type="button" aria-pressed={c.id === selectedId}
        className={`rounded border px-2 py-1.5 text-left text-xs ${c.id === selectedId ? 'border-ink bg-sun-soft' : 'border-line'}`}
        onClick={() => { select(c.id); setSource(''); setLicense('') }}>{clips.findIndex(v => v.id === c.clipId) + 1}. {c.label}{c.muted ? ' (mute)' : ''}{c.manual ? ' · manual' : ''}</button>)}
    </div>
    {cue && clip && <div className="flex flex-col gap-3 border-t border-line pt-3">
      <label className="text-xs">Nama efek<input aria-label="Nama efek" className={inputCls} value={cue.label} onChange={e => updateSfxCue(cue.id, { label: e.target.value })} /></label>
      <Select label="Adegan efek" value={cue.clipId} options={clips.map((c,i) => ({ value: c.id, label: `${i+1}. ${c.title}` }))} onChange={clipId => updateSfxCue(cue.id, { clipId, startMs: 0 })} />
      <Select label="Sumber efek" value={cue.preset ? `preset:${cue.preset}` : `asset:${cue.assetId}`}
        options={[...SFX_PRESETS.map(p => ({ value: `preset:${p.value}`, label: p.label })), ...sources.map(a => ({ value: `asset:${a.id}`, label: a.prompt ?? a.id }))]}
        onChange={value => {
          const preset = value.startsWith('preset:') ? value.slice(7) as SfxPreset : null
          const assetId = preset ? null : value.slice(6), length = assetId ? assets[assetId].durationMs! : cue.durationMs
          updateSfxCue(cue.id, { preset, assetId, inMs: 0, sourceDurationMs: undefined,
            durationMs: Math.min(cue.durationMs, length), fadeInMs: 0, fadeOutMs: Math.min(50, Math.floor(Math.min(cue.durationMs, length) / 2)) })
        }} />
      <div className="grid grid-cols-2 gap-2">
        {num('Mulai (detik)', cue.startMs/1000, v => updateSfxCue(cue.id, { startMs: Math.round(v*1000) }), 0, (clip.durationMs-1)/1000, .01)}
        {num('Durasi (detik)', cue.durationMs/1000, v => {
          const ms = Math.round(v*1000); updateSfxCue(cue.id, { durationMs: ms, sourceDurationMs: cue.preset ? cue.inMs+ms : undefined,
            fadeInMs: Math.min(cue.fadeInMs, Math.floor(ms/2)), fadeOutMs: Math.min(cue.fadeOutMs, Math.floor(ms/2)) })
        }, .001, (selectedAsset ? selectedAsset.durationMs!-cue.inMs : clip.durationMs-cue.startMs)/1000, .01)}
        {num('Volume (dB)', cue.gainDb, gainDb => updateSfxCue(cue.id, { gainDb }), -60, 12)}
        {num('Awal sumber (detik)', cue.inMs/1000, v => updateSfxCue(cue.id, { inMs: Math.round(v*1000) }), 0, Math.max(0, (selectedAsset?.durationMs ?? cue.sourceDurationMs ?? cue.durationMs)-cue.durationMs)/1000, .01)}
        {num('Fade masuk (ms)', cue.fadeInMs, fadeInMs => updateSfxCue(cue.id, { fadeInMs }), 0, cue.durationMs-cue.fadeOutMs)}
        {num('Fade keluar (ms)', cue.fadeOutMs, fadeOutMs => updateSfxCue(cue.id, { fadeOutMs }), 0, cue.durationMs-cue.fadeInMs)}
      </div>
      <Switch label="Mute efek ini" on={cue.muted} onChange={muted => updateSfxCue(cue.id, { muted })} />
      <Switch label="Ambience / lapisan latar (duck saat narasi)" on={cue.bed} onChange={bed => updateSfxCue(cue.id, { bed })} />
      {selectedAsset && <div className="flex flex-col gap-2">
        <p className="text-xs text-muted">Sumber: {String(selectedAsset.meta.source ?? 'belum diisi')} · Lisensi: {String(selectedAsset.meta.license ?? 'belum diisi')}</p>
        <label className="text-xs">Sumber / URL<input className={inputCls} aria-label="Sumber / URL" value={source} onChange={e => setSource(e.target.value)} /></label>
        <label className="text-xs">Lisensi / izin penggunaan<input className={inputCls} aria-label="Lisensi / izin penggunaan" value={license} onChange={e => setLicense(e.target.value)} /></label>
        <Button variant="secondary" disabled={!source.trim() || !license.trim()} onClick={() => void run(async () => { addAsset(await window.api.sound.assetInfo(project.id, selectedAsset.id, source, license)) })}>Simpan sumber dan lisensi</Button>
      </div>}
      <Button variant="secondary" onClick={() => removeSfxCue(cue.id)}>Hapus efek</Button>
    </div>}
  </div>
}
