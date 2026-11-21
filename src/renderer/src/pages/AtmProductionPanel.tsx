import { useEffect, useState } from 'react'
import { ArrowRight, Download, ImagePlus, Play, Sparkles } from 'lucide-react'
import type { AtmPackagePatch, AtmProductionDetail, AtmReference } from '@shared/atm'
import { Button, inputCls, cx } from '../components/ui'
import { useApp } from '../store/app'
import { runAtmTask } from '../lib/atmTasks'
import { errorText } from '../lib/format'
import { readImage, downloadText } from './AtmStudio'
import { Select } from '../components/Select'
import { CharacterConsistencyPanel } from '../components/CharacterConsistencyPanel'

export function AtmProductionPanel({ projectId, references, onChanged }: { projectId: string; references: AtmReference[]; onChanged: () => void }) {
  const { go, toast } = useApp()
  const [detail, setDetail] = useState<AtmProductionDetail | null>(null)
  const [busy, setBusy] = useState('')
  const [patch, setPatch] = useState<AtmPackagePatch>({})
  const [model, setModel] = useState('gemini-3.1-flash-image')
  const [thumbnailProvider, setThumbnailProvider] = useState<'gemini' | '9router'>('gemini')
  useEffect(() => { let live = true; void window.api.atm.production(projectId).then((d) => { if (live) setDetail(d) }).catch((e) => toast('error', errorText(e))); return () => { live = false } }, [projectId])
  useEffect(() => { const timer = setInterval(() => void window.api.atm.production(projectId).then(setDetail).catch(() => {}), 5000); return () => clearInterval(timer) }, [projectId])
  const act = async (name: string, fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(name)
    try { await fn(); setDetail(await window.api.atm.production(projectId)); onChanged() } catch (e) { toast('error', errorText(e)) } finally { setBusy('') }
  }
  const save = async () => {
    if (Object.keys(patch).length) { await window.api.atm.savePackage(projectId, patch); setPatch({}) }
  }
  if (!detail) return <p className="p-5 text-sm text-muted">Memuat produksi…</p>
  const p = detail.production
  const pack = p.package ? { ...p.package, ...patch } : null
  return <section className="min-w-0 rounded-2xl border border-line bg-surface p-5">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-display text-xl font-bold">{detail.summary.title}</h3><p className="mt-2 text-sm text-muted">Snapshot skill v{p.skillSnapshot.version} · {detail.summary.sceneCount} adegan · {detail.summary.imagesReady} gambar · {detail.summary.voicesReady} suara</p></div><Button icon={<ArrowRight className="size-4" />} disabled={!!busy || !!Object.keys(patch).length} onClick={() => go({ name: 'project', id: projectId })}>Buka editor video</Button></div>
    <p className="mb-4 rounded-xl bg-sun-soft px-4 py-3 text-sm text-sun-ink">{busy || detail.nextAction}{busy ? '…' : ''}</p>
    <div className="mb-5 flex flex-wrap gap-2">
      <Button variant="primary" disabled={!!busy || detail.summary.sceneCount > 0} icon={<Play className="size-4" />} onClick={() => void act('Menyusun alur utuh, naskah, dan judul', async () => { await runAtmTask({ workspaceId: p.workspaceId, kind: 'prepare-production', projectId }, setBusy) })}>Siapkan cerita + judul</Button>
      <Button disabled={!!busy || !detail.summary.sceneCount} icon={<Sparkles className="size-4" />} onClick={() => void act('Membuat pilihan judul dan konsep thumbnail', () => runAtmTask({ workspaceId: p.workspaceId, kind: 'generate-package', projectId }, setBusy))}>{pack ? 'Buat ulang paket publikasi' : 'Siapkan paket publikasi'}</Button>
      <Button disabled={!!busy || !detail.summary.sceneCount} onClick={() => void act('Menyiapkan storyboard dari cerita dan skill', () => window.api.story.visuals(projectId, 'missing'))}>Siapkan storyboard</Button>
      <Button variant="ink" disabled={!!busy || !detail.summary.sceneCount || detail.summary.packageStale || Object.keys(patch).length > 0} onClick={() => void act('Memproduksi video otomatis', async () => { await runAtmTask({ workspaceId: p.workspaceId, kind: 'produce-video', projectId, model, thumbnailProvider }, setBusy) })}>Buat video otomatis</Button>
    </div>
    <p className="mb-5 text-xs leading-5 text-muted">Produksi otomatis membuat gambar adegan, narasi, caption, video MP4, dan thumbnail melalui provider yang dipilih. Biaya mengikuti jumlah adegan dan tarif provider. Progres tersimpan di Riwayat tugas.</p>
    {p.outline && <details className="mb-5 rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-semibold">Lihat rancangan alur & hubungan sebab-akibat</summary><p className="my-3 text-sm leading-6">{p.outline.premise}</p><p className="mb-3 text-xs leading-6 text-muted">Ciri khas baru: {p.outline.innovation}</p><ol className="space-y-3">{p.outline.beats.map((b, i) => <li key={i} className="border-l-2 border-sun pl-3 text-xs leading-6"><strong>{b.day}</strong> · {b.event}<br />Pilihan: {b.choice}<br />Biaya: {b.cost}<br />Payoff: {b.payoff}</li>)}</ol><p className="mt-4 text-sm leading-6">{p.outline.endingPayoff}</p></details>}
    {detail.summary.packageStale && <p className="mb-4 rounded-xl bg-bad-soft p-3 text-sm text-bad-ink">Naskah berubah setelah paket dibuat. Buat ulang paket publikasi agar janjinya tetap sesuai.</p>}
    <CharacterConsistencyPanel projectId={projectId} />
    {pack && <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      <div className="min-w-0">
        <h4 className="mb-3 text-sm font-bold">Judul yang sesuai isi cerita</h4>
        <div className="space-y-2">{pack.titleOptions.map((t) => <button key={t.title} disabled={!!busy} className={cx('w-full rounded-xl border p-3 text-left', pack.selectedTitle === t.title ? 'border-sun bg-sun-soft' : 'border-line hover:bg-sand')} onClick={() => setPatch((p) => ({ ...p, selectedTitle: t.title }))}><span className="text-sm font-semibold">{t.title}</span><span className="mt-1 block text-xs leading-5 text-muted">{t.angle}</span></button>)}</div>
        <label className="mt-4 block text-sm font-medium">Judul terpilih<input aria-label="Judul terpilih" maxLength={100} className={cx(inputCls, 'mt-2 w-full')} value={pack.selectedTitle} onChange={(e) => setPatch((p) => ({ ...p, selectedTitle: e.target.value }))} /></label>
        <label className="mt-4 block text-sm font-medium">Deskripsi video<textarea className={cx(inputCls, 'mt-2 min-h-44 w-full py-3 text-xs leading-6')} value={pack.description} onChange={(e) => setPatch((p) => ({ ...p, description: e.target.value }))} /></label>
        <Button className="mt-3" icon={<Download className="size-4" />} onClick={() => downloadText('youtube-publishing-package.md', '# ' + pack.selectedTitle + '\n\n' + pack.description + '\n\n## Thumbnail artwork prompt\n\n' + pack.thumbnailPrompt + '\n\nSkill snapshot: v' + p.skillSnapshot.version)}>Unduh paket judul & deskripsi</Button>
      </div>
      <div className="min-w-0">
        <h4 className="mb-3 text-sm font-bold">Thumbnail dengan gambar referensi</h4>
        <div className="mb-3 grid grid-cols-3 gap-2">{references.filter((r) => r.thumbnailUrl).map((r) => <button key={r.id} title={r.title} aria-label={'Referensi thumbnail: ' + r.title} aria-pressed={pack.referenceIds.includes(r.id)} disabled={!!busy || (!pack.referenceIds.includes(r.id) && pack.referenceIds.length >= 3)} onClick={() => setPatch((p) => ({ ...p, referenceIds: pack.referenceIds.includes(r.id) ? pack.referenceIds.filter((id) => id !== r.id) : [...pack.referenceIds, r.id] }))} className={cx('overflow-hidden rounded-lg border-[3px]', pack.referenceIds.includes(r.id) ? 'border-accent bg-sun-soft' : 'border-transparent opacity-60')}><img src={r.thumbnailUrl} alt={r.title} className="aspect-video w-full object-cover" /></button>)}</div>
        <p className="mb-3 text-xs leading-5 text-muted">{pack.referenceIds.length} gambar referensi dipilih (maksimal 3). Gambar dikirim ke pembuat ilustrasi sebagai panduan visual; karakter dan kejadian mengikuti cerita baru.</p>
        <label className="block text-sm font-medium">Arahan ilustrasi<textarea className={cx(inputCls, 'mt-2 min-h-36 w-full py-3 text-xs leading-6')} value={pack.thumbnailPrompt} onChange={(e) => setPatch((p) => ({ ...p, thumbnailPrompt: e.target.value }))} /></label>
        <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs font-semibold">Label kiri<input aria-label="Label thumbnail kiri" className={cx(inputCls, 'mt-2 w-full')} maxLength={16} value={pack.beforeLabel} onChange={(e) => setPatch((p) => ({ ...p, beforeLabel: e.target.value }))} /></label><label className="text-xs font-semibold">Label kanan<input aria-label="Label thumbnail kanan" className={cx(inputCls, 'mt-2 w-full')} maxLength={16} value={pack.afterLabel} onChange={(e) => setPatch((p) => ({ ...p, afterLabel: e.target.value }))} /></label></div>
        <div className="mt-3"><p className="mb-2 text-xs font-semibold">Pembuat ilustrasi</p><Select label="Provider thumbnail" value={thumbnailProvider} options={[{value:'gemini',label:'Gemini langsung'},{value:'9router',label:'9Router — gambar berreferensi'}]} onChange={(v) => { setThumbnailProvider(v); setModel(v === '9router' ? 'cx/gpt-image-2.5' : 'gemini-3.1-flash-image') }} /></div>
        <label className="mt-3 block text-xs font-semibold">Model gambar<input aria-label="Model thumbnail" className={cx(inputCls, 'mt-2 w-full text-xs')} value={model} onChange={(e) => setModel(e.target.value)} /></label>
        <p className="mt-2 text-xs leading-5 text-muted">{thumbnailProvider === '9router' ? 'Memakai koneksi 9Router dari Pengaturan dan model cx/ dengan dukungan gambar referensi.' : 'Memakai kunci Gemini dari Pengaturan.'} Pembuatan ilustrasi mengikuti tarif dan akses akun provider.</p>
        <div className="my-4 flex flex-wrap gap-2"><Button variant="primary" disabled={!!busy || detail.summary.packageStale} icon={<Sparkles className="size-4" />} onClick={() => void act('Membuat ilustrasi dengan gambar referensi', async () => { await save(); await runAtmTask({ workspaceId: p.workspaceId, kind: 'generate-thumbnail', projectId, model, thumbnailProvider }, setBusy) })}>Buat ilustrasi + thumbnail</Button><label className={cx('inline-flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm', busy && 'pointer-events-none opacity-50')}><ImagePlus className="size-4" />Unggah ilustrasi<input type="file" className="sr-only" disabled={!!busy} accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void act('Mengimpor ilustrasi dari agent', async () => { const data = await readImage(f); await save(); await window.api.atm.importArtwork(projectId, data) }); e.target.value = '' }} /></label></div>
        {detail.thumbnailUrl ? <><img src={detail.thumbnailUrl} alt="Thumbnail final video" className="aspect-video w-full rounded-xl border border-line object-cover" /><a href={detail.thumbnailUrl} download="thumbnail.jpg" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent"><Download className="size-4" />Unduh thumbnail 1280 × 720</a></>
          : detail.artworkUrl ? <img src={detail.artworkUrl} alt="Ilustrasi thumbnail sebelum label" className="aspect-video w-full rounded-xl object-cover" /> : <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-line-2 bg-sand px-5 text-center text-sm text-muted">Ilustrasi AI + teks yang bisa diedit akan tampil di sini.</div>}
        {detail.artworkUrl && <Button className="mt-3" disabled={!!busy} onClick={() => void act('Merender ulang teks thumbnail', async () => { await save(); await window.api.atm.renderThumbnail(projectId) })}>Perbarui teks tanpa generate ulang gambar</Button>}
      </div>
      {!!Object.keys(patch).length && <div className="col-span-full flex items-center gap-3 rounded-xl bg-sun-soft p-3"><span className="flex-1 text-sm text-sun-ink">Ada perubahan paket yang belum disimpan.</span><Button variant="primary" disabled={!!busy} onClick={() => void act('Menyimpan paket publikasi', save)}>Simpan perubahan</Button></div>}
    </div>}
  </section>
}
