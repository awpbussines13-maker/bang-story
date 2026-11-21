import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Check, Download, Film, FolderPlus, Link, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { AtmBundle, AtmReference, AtmReferenceInput, AtmSkill, AtmWorkspace } from '@shared/atm'
import { Button, IconButton, Modal, inputCls, cx, confirmDialog } from '../components/ui'
import { Select } from '../components/Select'
import { useApp } from '../store/app'
import { runAtmTask } from '../lib/atmTasks'
import { errorText } from '../lib/format'
import { AtmProductionPanel } from './AtmProductionPanel'

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function readImage(file: File): Promise<string> {
  if (file.size > 6 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return Promise.reject(new Error('Pilih PNG, JPEG, atau WebP dengan ukuran maksimal 6 MB.'))
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('File gambar tidak terbaca.')); reader.readAsDataURL(file) })
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">{title}{children}</label>
}

export function AtmStudio({ initialWorkspaceId, initialProjectId }: { initialWorkspaceId?: string; initialProjectId?: string }) {
  const { go, toast } = useApp()
  const [workspaces, setWorkspaces] = useState<AtmWorkspace[]>([])
  const [selected, setSelected] = useState(initialWorkspaceId || '')
  const [creating, setCreating] = useState(false)
  const [ready, setReady] = useState(false)
  const refresh = async () => {
    const rows = await window.api.atm.list()
    setWorkspaces(rows); setSelected((id) => id || rows[0]?.id || ''); setReady(true)
  }
  useEffect(() => { void refresh().catch((e) => { toast('error', errorText(e)); setReady(true) }) }, [])
  return <div className="flex h-full flex-col bg-paper">
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-5 py-4">
      <IconButton label="Kembali ke beranda" onClick={() => go({ name: 'home' })}><ArrowLeft className="size-5" /></IconButton>
      <div className="min-w-0 flex-1"><h1 className="font-display text-xl font-bold">ATM Studio</h1><p className="text-xs text-muted">Amati · Tiru prinsipnya · Modifikasi · Improvisasi</p></div>
      <Button icon={<FolderPlus className="size-4" />} onClick={() => setCreating(true)}>Ruang baru</Button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-auto border-b border-line bg-surface p-3 md:w-60 md:flex-col md:border-r md:border-b-0">
        <p className="hidden px-2 py-3 text-[11px] font-bold tracking-widest text-muted md:block">CHANNEL & SERI</p>
        {workspaces.map((w) => <button key={w.id} onClick={() => setSelected(w.id)} className={cx('min-w-40 rounded-xl border px-3 py-3 text-left text-sm', selected === w.id ? 'border-sun bg-sun-soft' : 'border-transparent hover:bg-sand')}>
          <span className="block font-semibold">{w.name}</span><span className="mt-1 block text-xs text-muted">{w.language === 'en' ? 'Konten Inggris' : 'Konten Indonesia'} · {w.activeSkillId ? 'Skill aktif' : 'Belum ada skill aktif'}</span>
        </button>)}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {selected ? <WorkspaceView key={selected} id={selected} initialProjectId={initialProjectId} onChanged={() => void refresh()} />
          : <div className="mx-auto max-w-xl p-8 pt-20 text-center"><BookOpen className="mx-auto mb-5 size-12 text-accent" /><h2 className="font-display text-3xl font-bold">{ready ? 'Mulai dari satu channel referensi' : 'Memuat ruang ATM…'}</h2><p className="my-4 text-sm leading-7 text-muted">Simpan sumber dan hasil bedahan menjadi skill. Pakai versi skill yang sama untuk membuat cerita, video, judul, dan thumbnail yang saling sesuai.</p>{ready && <Button variant="primary" onClick={() => setCreating(true)}>Buat ruang ATM</Button>}</div>}
      </main>
    </div>
    {creating && <WorkspaceForm onClose={() => setCreating(false)} onSaved={(w) => { setSelected(w.id); setCreating(false); void refresh() }} />}
  </div>
}

function WorkspaceForm({ current, onClose, onSaved }: { current?: AtmWorkspace; onClose: () => void; onSaved: (w: AtmWorkspace) => void }) {
  const { toast } = useApp()
  const [name, setName] = useState(current?.name || '')
  const [url, setUrl] = useState(current?.channelUrl || '')
  const [language, setLanguage] = useState(current?.language || 'en')
  const [notes, setNotes] = useState(current?.notes || '')
  const [busy, setBusy] = useState(false)
  const save = async () => { setBusy(true); try { onSaved(await window.api.atm.saveWorkspace({ id: current?.id, name, channelUrl: url, language, notes })) } catch(e) { toast('error', errorText(e)) } finally { setBusy(false) } }
  return <Modal open title={current ? 'Pengaturan ruang ATM' : 'Buat ruang ATM'} onClose={onClose} width={600}>
    <div className="flex flex-col gap-4 p-5">
      <Field title="Nama channel atau seri"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Misalnya: Survival — Nobody Gets In" /></Field>
      <Field title="URL channel referensi"><input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/@NamaChannel" /></Field>
      <Field title="Bahasa konten"><Select label="Bahasa konten" value={language} onChange={setLanguage} options={[{ value: 'en', label: 'Inggris' }, { value: 'id', label: 'Indonesia' }]} /></Field>
      <Field title="Arah dan ciri khas channel kamu"><textarea className={cx(inputCls, 'min-h-24 py-3')} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Apa yang ingin dipertahankan, dimodifikasi, dan ditingkatkan?" /></Field>
      <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>Simpan ruang ATM</Button>
    </div>
  </Modal>
}

function WorkspaceView({ id, initialProjectId, onChanged }: { id: string; initialProjectId?: string; onChanged: () => void }) {
  const { toast } = useApp()
  const [bundle, setBundle] = useState<AtmBundle | null>(null)
  const [tab, setTab] = useState(initialProjectId ? 'productions' : 'sources')
  const [busy, setBusy] = useState('')
  const [url, setUrl] = useState('')
  const [refForm, setRefForm] = useState<AtmReference | 'new' | null>(null)
  const [editing, setEditing] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState('')
  const [projectId, setProjectId] = useState(initialProjectId || '')
  const [brief, setBrief] = useState('')
  const [duration, setDuration] = useState(540)
  const [language, setLanguage] = useState('en')
  const reload = async () => { const b = await window.api.atm.get(id); setBundle(b); setLanguage(b.workspace.language); setSelectedSkill((s) => s || b.workspace.activeSkillId || b.skills[0]?.id || '') }
  useEffect(() => { let live = true; void window.api.atm.get(id).then((b) => { if (live) { setBundle(b); setLanguage(b.workspace.language); setSelectedSkill(b.workspace.activeSkillId || b.skills[0]?.id || '') } }).catch((e) => toast('error', errorText(e))); return () => { live = false } }, [id])
  useEffect(() => {
    if (!bundle?.tasks.some((t) => t.status === 'running')) return
    const timer = setInterval(() => void reload().catch(() => {}), 3500)
    return () => clearInterval(timer)
  }, [bundle?.tasks.some((t) => t.status === 'running')])
  const act = async (name: string, fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(name)
    try { await fn(); await reload(); onChanged() } catch (e) { toast('error', errorText(e)) } finally { setBusy('') }
  }
  if (!bundle) return <div className="p-8 text-muted">Memuat referensi dan skill…</div>
  const { workspace, references, skills, productions } = bundle
  const storySources = references.filter((r) => r.transcript.trim() || r.videoAnalysis.trim()).length
  const currentSkill = skills.find((s) => s.id === selectedSkill) || skills[0]
  const tabs = [{ id: 'sources', label: '1. Referensi', count: references.length }, { id: 'skills', label: '2. Skill cerita', count: skills.length }, { id: 'productions', label: '3. Produksi & publikasi', count: productions.length }]
  return <div className="mx-auto max-w-6xl p-5 lg:p-8">
    <div className="mb-6 flex items-start justify-between gap-3">
      <div><p className="mb-1 text-xs font-semibold uppercase tracking-widest text-accent">Ruang kerja ATM</p><h2 className="font-display text-3xl font-bold">{workspace.name}</h2><p className="mt-2 text-sm text-muted">{references.length} referensi · {storySources} sumber isi cerita · {workspace.activeSkillId ? 'Skill aktif v' + skills.find((s) => s.id === workspace.activeSkillId)?.version : 'Aktifkan skill sebelum produksi'}</p></div>
      <IconButton label="Pengaturan ruang ATM" onClick={() => setEditing(true)}><Pencil className="size-4" /></IconButton>
    </div>
    <div className="mb-6 flex gap-2 overflow-x-auto border-b border-line pb-3">{tabs.map((t) => <button key={t.id} onClick={() => setTab(t.id)} className={cx('whitespace-nowrap rounded-full px-4 py-2.5 text-sm font-semibold', tab === t.id ? 'bg-ink text-white' : 'text-muted hover:bg-sand')}>{t.label} <span className="ml-1 opacity-60">{t.count}</span></button>)}</div>
    {busy && <p role="status" className="mb-5 rounded-xl bg-sun-soft px-4 py-3 text-sm text-sun-ink">{busy}… Kamu bisa mengikuti proses di halaman ini.</p>}
    {!!bundle.tasks.length && <details className="mb-5 rounded-xl border border-line bg-surface p-4" open={bundle.tasks.some((t) => t.status === 'running')}><summary className="cursor-pointer text-xs font-semibold">Riwayat tugas · {bundle.tasks.filter((t) => t.status === 'running').length} berjalan</summary><div className="mt-3 space-y-2">{bundle.tasks.slice(0, 6).map((t) => <div key={t.id} className="flex items-center gap-3 rounded-lg bg-paper px-3 py-2 text-xs"><span className="min-w-0 flex-1"><strong>{t.status === 'running' ? 'Berjalan' : t.status === 'done' ? 'Selesai' : t.status === 'canceled' ? 'Dibatalkan' : 'Gagal'}</strong> · {t.message}{t.error && <span className="mt-1 block text-bad-ink">{t.error}</span>}</span>{t.status === 'running' && <Button size="sm" onClick={() => void window.api.atm.cancelTask(t.id).then(reload).catch((e) => toast('error', errorText(e)))}>Batalkan</Button>}</div>)}</div></details>}
    {tab === 'sources' && <>
      <div className="mb-5 rounded-2xl border border-line bg-surface p-5">
        <h3 className="mb-2 font-display text-lg font-bold">Bedah materi yang benar-benar tersedia</h3>
        <p className="mb-4 text-sm leading-6 text-muted">Impor judul dan thumbnail, lalu tambahkan transkrip atau gunakan Gemini untuk membaca isi video. AI menyimpan temuan dan keterbatasan sumbernya. Angka views saja belum menjelaskan CTR atau retensi.</p>
        <div className="flex flex-wrap gap-2"><input className={cx(inputCls, 'min-w-0 flex-1')} aria-label="URL video referensi" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Tempel URL video YouTube" /><Button disabled={!url.trim() || !!busy} icon={<Link className="size-4" />} onClick={() => void act('Mengimpor video', async () => { await window.api.atm.importReference(id, url); setUrl('') })}>Impor video</Button><Button disabled={!!busy || !workspace.channelUrl} onClick={() => void act('Mengimpor maksimal 8 video channel', async () => { const r = await window.api.atm.importChannel(id); toast(r.warnings.length ? 'info' : 'success', r.imported + ' video diimpor.' + (r.warnings[0] ? ' ' + r.warnings[0] : '')) })}>Impor channel</Button><Button onClick={() => setRefForm('new')} icon={<Plus className="size-4" />}>Manual</Button></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">{references.map((r) => <article key={r.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
        {r.thumbnailUrl && <button className="block w-full bg-sand" onClick={() => setRefForm(r)} aria-label={'Edit referensi ' + r.title}><img src={r.thumbnailUrl} alt={'Thumbnail referensi: ' + r.title} className="aspect-video max-h-52 w-full object-cover" loading="lazy" /></button>}
        <div className="p-4"><div className="mb-2 flex flex-wrap gap-2"><span className={cx('rounded-full px-2.5 py-1 text-[11px] font-semibold', r.transcript || r.videoAnalysis ? 'bg-ok-soft text-ok-ink' : 'bg-sun-soft text-sun-ink')}>{r.transcript ? 'Transkrip tersedia' : r.videoAnalysis ? 'Video dibedah Gemini' : 'Metadata saja'}</span>{r.viewCount !== null && <span className="py-1 text-xs text-muted">{r.viewCount.toLocaleString('en')} views · snapshot</span>}</div><h3 className="text-sm font-bold leading-6">{r.title}</h3>
        {r.notes && <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">{r.notes}</p>}
        <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" onClick={() => setRefForm(r)}>Edit / transkrip</Button><Button size="sm" disabled={!!busy || !r.url} icon={<Sparkles className="size-3.5" />} onClick={() => void act('Gemini membaca audio dan visual video', () => runAtmTask({ workspaceId: id, kind: 'analyze-reference', referenceId: r.id }, setBusy))}>Bedah video · Gemini</Button><IconButton label="Hapus referensi" onClick={() => void act('Menghapus referensi', async () => { if (await confirmDialog({ title: 'Hapus referensi?', body: 'Referensi ini dihapus dari ruang ATM. Versi skill dan project yang sudah tersimpan tetap ada.', confirm: 'Hapus', danger: true })) await window.api.atm.removeReference(id, r.id) })}><Trash2 className="size-4" /></IconButton></div>
        {r.videoAnalysis && <details className="mt-4 border-t border-line pt-3"><summary className="cursor-pointer text-sm font-semibold">Lihat bedahan video</summary><div className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-6 text-ink-2">{r.videoAnalysis}</div></details>}
        </div>
      </article>)}</div>
      {!references.length && <p className="rounded-xl border border-dashed border-line-2 p-10 text-center text-sm text-muted">Tambahkan video pertama untuk mulai mengamati.</p>}
      <div className="mt-6 flex justify-end"><Button variant="primary" disabled={!references.length} onClick={() => setTab('skills')}>Lanjut ke skill <ArrowRight className="size-4" /></Button></div>
    </>}
    {tab === 'skills' && <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-5"><div><h3 className="font-display text-lg font-bold">Panduan cerita yang bisa dipakai ulang</h3><p className="mt-1 max-w-xl text-sm text-muted">Setiap simpan membuat versi baru. Project produksi menyimpan snapshot versi yang dipilih.</p></div><Button variant="primary" disabled={!references.length || !!busy} icon={<Sparkles className="size-4" />} onClick={() => void act('Menganalisis sumber dan menyusun skill', async () => { const s = await runAtmTask({ workspaceId: id, kind: 'analyze-workspace' }, setBusy) as AtmSkill; setSelectedSkill(s.id) })}>Analisis → buat skill</Button></div>
      {!storySources && <p className="mb-5 rounded-xl bg-sun-soft p-4 text-sm leading-6 text-sun-ink">Isi cerita belum tersedia. Skill dari judul dan catatan akan diberi status sementara. Tambahkan transkrip atau bedah video untuk mendalami alurnya.</p>}
      {skills.length > 0 && <div className="mb-4 flex flex-wrap gap-2">{skills.map((s) => <button key={s.id} className={cx('rounded-xl border px-3 py-2 text-sm', s.id === currentSkill?.id ? 'border-sun bg-sun-soft' : 'border-line bg-surface')} onClick={() => setSelectedSkill(s.id)}>v{s.version} {workspace.activeSkillId === s.id && '· Aktif'}</button>)}</div>}
      <SkillEditor key={currentSkill?.id || 'new'} workspaceId={id} skill={currentSkill} busy={!!busy} active={workspace.activeSkillId === currentSkill?.id} onSave={(input) => void act('Menyimpan versi skill', async () => { const s = await window.api.atm.saveSkill(input); setSelectedSkill(s.id) })} onActivate={() => currentSkill && void act('Mengaktifkan skill', () => window.api.atm.activateSkill(id, currentSkill.id))} />
      {workspace.activeSkillId && <div className="mt-5 flex justify-end"><Button variant="primary" onClick={() => setTab('productions')}>Mulai produksi <ArrowRight className="size-4" /></Button></div>}
    </>}
    {tab === 'productions' && <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-line bg-surface p-5"><h3 className="mb-3 font-display text-lg font-bold">Buat cerita baru dari skill aktif</h3><textarea aria-label="Ide cerita produksi" className={cx(inputCls, 'min-h-28 w-full py-3')} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Tentukan tempat, rentang hari, kendala unik, dan dilema. Contoh: terjebak di terminal feri yang perlahan terendam, bersama seseorang yang menyembunyikan rencana evakuasi…" /><div className="mt-4 flex flex-wrap items-center gap-3"><Select label="Durasi video" value={duration} onChange={setDuration} options={[{ value: 180, label: '3 menit' },{ value: 480, label: '8 menit' },{ value: 540, label: '9 menit' },{ value: 600, label: '10 menit' }]} /><Select label="Bahasa produksi" value={language} onChange={setLanguage} options={[{ value: 'en', label: 'Inggris' },{ value: 'id', label: 'Indonesia' }]} /><Button variant="primary" disabled={!workspace.activeSkillId || brief.trim().length < 10 || !!busy} icon={<Film className="size-4" />} onClick={() => void act('Membuat project dengan snapshot skill', async () => { const d = await window.api.atm.createProduction({ workspaceId: id, synopsis: brief, durationSec: duration, language, idempotencyKey: crypto.randomUUID() }); setProjectId(d.production.projectId); setBrief('') })}>Buat project</Button></div>{!workspace.activeSkillId && <p className="mt-3 text-sm text-accent">Aktifkan skill di tab Skill cerita dulu.</p>}</div>
      {!!productions.length && <div className="flex flex-wrap gap-2">{productions.map((p) => <button key={p.projectId} onClick={() => setProjectId(p.projectId)} className={cx('max-w-xs rounded-xl border p-3 text-left text-sm', projectId === p.projectId ? 'border-sun bg-sun-soft' : 'border-line bg-surface')}><span className="block truncate font-semibold">{p.title}</span><span className="mt-1 block text-xs text-muted">Skill v{p.skillVersion} · {p.sceneCount} adegan · {p.status}</span></button>)}</div>}
      {projectId && <AtmProductionPanel key={projectId} projectId={projectId} references={references} onChanged={() => void reload()} />}
    </div>}
    {refForm && <ReferenceForm workspaceId={id} reference={refForm === 'new' ? undefined : refForm} onClose={() => setRefForm(null)} onSaved={() => { setRefForm(null); void reload() }} />}
    {editing && <WorkspaceForm current={workspace} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); onChanged() }} />}
  </div>
}

function SkillEditor({ workspaceId, skill, active, busy, onSave, onActivate }: { workspaceId: string; skill?: AtmSkill; active: boolean; busy: boolean; onSave: (input: { workspaceId: string; name: string; instructions: string; analysis: string; sourceIds?: string[] }) => void; onActivate: () => void }) {
  const [name, setName] = useState(skill?.name || 'Survival story skill')
  const [instructions, setInstructions] = useState(skill?.instructions || '')
  const [analysis, setAnalysis] = useState(skill?.analysis || '')
  return <div className="rounded-2xl border border-line bg-surface p-5">
    <div className="mb-4 flex flex-wrap items-center gap-2"><span className="mr-auto text-xs text-muted">{skill ? 'Versi ' + skill.version + ' · ' + (skill.evidence === 'metadata' ? 'Sementara: metadata' : 'Sumber isi cerita tersedia') : 'Tulis panduan sendiri atau buat dari analisis'}</span>{skill && <Button size="sm" icon={<Download className="size-4" />} onClick={() => downloadText('SKILL.md', '---\nname: atm-survival-storytelling\ndescription: Use when writing original survival animation stories from this editorial profile.\n---\n\n# ' + skill.name + '\n\nVersion: ' + skill.version + '\n\n' + skill.instructions)}>Ekspor skill</Button>}<Button size="sm" disabled={!skill || active || busy} icon={<Check className="size-4" />} onClick={onActivate}>{active ? 'Versi aktif' : 'Aktifkan versi ini'}</Button></div>
    <Field title="Nama skill"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <div className="mt-4"><Field title="Instruksi penulisan (digunakan AI)"><textarea className={cx(inputCls, 'min-h-72 py-3 font-mono text-xs leading-6')} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field></div>
    <details className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Hasil analisis & bukti</summary><textarea aria-label="Analisis dan bukti skill" className={cx(inputCls, 'mt-3 min-h-60 w-full py-3 text-xs leading-6')} value={analysis} onChange={(e) => setAnalysis(e.target.value)} /></details>
    <Button className="mt-4" variant="primary" disabled={busy || !name.trim() || instructions.trim().length < 30} onClick={() => onSave({ workspaceId, name, instructions, analysis, sourceIds: skill?.sourceIds })}>{skill ? 'Simpan sebagai versi baru' : 'Simpan skill'}</Button>
  </div>
}

function ReferenceForm({ workspaceId, reference, onClose, onSaved }: { workspaceId: string; reference?: AtmReference; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const [form, setForm] = useState<AtmReferenceInput>({ workspaceId, id: reference?.id, title: reference?.title || '', url: reference?.url || '', thumbnailUrl: reference?.thumbnailUrl || '', description: reference?.description || '', transcript: reference?.transcript || '', notes: reference?.notes || '', viewCount: reference?.viewCount ?? null, videoAnalysis: reference?.videoAnalysis || '' })
  const [busy, setBusy] = useState(false)
  const save = async () => { setBusy(true); try { await window.api.atm.saveReference(form); onSaved() } catch(e) { toast('error', errorText(e)) } finally { setBusy(false) } }
  return <Modal open title={reference ? 'Edit referensi' : 'Tambah referensi manual'} onClose={onClose} width={760}><div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto p-5">
    <Field title="Judul video"><input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
    <Field title="URL video YouTube"><input className={inputCls} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
    <Field title="Deskripsi / chapter"><textarea className={cx(inputCls, 'min-h-24 py-3')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
    <Field title="Transkrip (jika tersedia)"><textarea className={cx(inputCls, 'min-h-44 py-3 text-xs leading-6')} value={form.transcript} onChange={(e) => setForm({ ...form, transcript: e.target.value })} placeholder="Tempel transkrip asli. Kosongkan jika belum tersedia." /></Field>
    <Field title="Catatan pengamatan & asal bukti"><textarea className={cx(inputCls, 'min-h-24 py-3')} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Pisahkan pengamatan langsung dan dugaan. Cantumkan timestamp bila ada." /></Field>
    <Field title="Views saat pengamatan (opsional)"><input type="number" min={0} className={inputCls} value={form.viewCount ?? ''} onChange={(e) => setForm({ ...form, viewCount: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
    <Field title="Gambar thumbnail referensi"><input type="file" accept="image/png,image/jpeg,image/webp" className="text-sm" onChange={(e) => { const file = e.target.files?.[0]; if (file) void readImage(file).then((thumbnailUrl) => setForm((f) => ({ ...f, thumbnailUrl }))).catch((e) => toast('error', errorText(e))) }} /></Field>
    {form.thumbnailUrl && <img src={form.thumbnailUrl} alt="Thumbnail referensi" className="max-h-48 rounded-xl object-contain" />}
    <Button variant="primary" loading={busy} disabled={!form.title.trim()} onClick={() => void save()}>Simpan referensi</Button>
  </div></Modal>
}
