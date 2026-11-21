import { useRef, useState } from 'react'
import { FLOW_IMAGE_ACCEPT, makeReferencePrompt } from '@shared/flowV2'
import { RefreshCw, Sparkles, Trash2, UserPlus } from 'lucide-react'
import { Button, Field, Modal, Progress, confirmDialog, cx, inputCls } from '../../components/ui'
import { errorText } from '../../lib/format'
import { useApp } from '../../store/app'
import { flushFlowProject, imageFileBytes } from './FlowImages'
import { isRunning, jobFor, useProject } from '../../store/project'

/**
 * Edits a character, or with `characterId` "new" collects a new one that is only added once it is saved,
 * so a misclick on "Tambah pemeran" leaves nothing behind.
 */
export function CharacterModal({
  characterId,
  onClose,
  onCreated
}: {
  characterId: string | null
  onClose: () => void
  /** Called with the id of a newly saved character, e.g. to keep its modal open for the sheet. */
  onCreated?: (id: string) => void
}) {
  if (characterId === 'new') return <NewCharacter onClose={onClose} onCreated={onCreated} />
  return <EditCharacter characterId={characterId} onClose={onClose} />
}

const LOOK_HINT =
  'Tulis ciri tubuh dulu, lalu "Default outfit:" untuk baju bawaan di lembar karakter. Baju bisa diganti per adegan lewat baris Wardrobe di prompt visual. Contoh: human man, 40s, short black hair, warm brown skin. Default outfit: light-blue colony medical scrubs, stethoscope.'

function NewCharacter({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const { addCharacter } = useProject()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [referencePrompt, setReferencePrompt] = useState<string | null>(null)
  const [reference, setReference] = useState<File>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savedId = useRef<string | null>(null)
  const typed = !!(name.trim() || description.trim() || referencePrompt?.trim() || reference)
  const prompt = referencePrompt ?? makeReferencePrompt(name, description)

  const save = async (): Promise<void> => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const bytes = reference ? await imageFileBytes(reference) : null
      const { project, updateCharacter } = useProject.getState()
      if (!project) return
      const fields = { name: name.trim(), description: description.trim(), referencePrompt: prompt }
      if (savedId.current) updateCharacter(savedId.current, fields)
      else savedId.current = addCharacter(fields)
      const id = savedId.current
      await flushFlowProject(project.id)
      if (bytes) {
        const asset = await window.api.flowImages.reference(project.id, id, bytes)
        if (asset) useProject.getState().addAsset(asset)
        useProject.getState().applyCharacter(id, { referenceImageAssetId: asset?.id ?? null })
      }
      if (onCreated) onCreated(id)
      else onClose()
    } catch (e) { setError(errorText(e)) }
    finally { setSaving(false) }
  }

  // Closing an untouched form adds nothing; closing after typing asks instead of guessing.
  const close = async (): Promise<void> => {
    if (saving) return
    if (!typed || savedId.current) return onClose()
    const keep = await confirmDialog({
      title: 'Simpan pemeran ini?',
      body: 'Kamu sudah mengisi data pemeran baru. Simpan sebagai pemeran, atau buang?',
      confirm: 'Simpan',
      cancel: 'Buang'
    })
    if (keep) await save()
    else onClose()
  }

  return (
    <Modal open onClose={() => void close()} title="Pemeran baru" subtitle="Isi nama dan penampilannya, lalu simpan. Lembar karakter bisa dibuat setelah itu." width={760}>
      <div className="flex h-[150px] flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-line-3 bg-paper text-sm text-ink-2">
        <UserPlus className="size-6 text-muted" />
        Lembar karakter dibuat setelah pemeran disimpan.
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[220px_minmax(0,1fr)] gap-4">
        <Field label="Nama">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Misal: Gajah Mada" className={cx(inputCls, 'h-11')} />
        </Field>
        <Field label="Penampilan" hint={LOOK_HINT}>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={cx(inputCls, 'resize-none py-2.5 text-sm leading-relaxed')}
          />
        </Field>
      </div>
      <ReferencePrompt value={prompt} onChange={setReferencePrompt} onGenerate={() => setReferencePrompt(null)} disabled={saving} />
      <ReferenceFile onChange={setReference} disabled={saving} />
      {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
      <div className="flex items-center justify-end gap-2.5">
        <Button onClick={onClose} disabled={saving}>Batal</Button>
        <Button variant="primary" disabled={!name.trim() || saving} loading={saving} onClick={() => void save()}>
          Simpan pemeran
        </Button>
      </div>
    </Modal>
  )
}

function EditCharacter({ characterId, onClose }: { characterId: string | null; onClose: () => void }) {
  const { characters, assets, jobs, updateCharacter, removeCharacter, flush, clips } = useProject()
  const { toast } = useApp()
  const [uploading, setUploading] = useState(false)
  const c = characters.find((x) => x.id === characterId)
  if (!c) return null
  const sheet = c.sheetAssetId ? assets[c.sheetAssetId] : null
  const reference = c.referenceImageAssetId ? assets[c.referenceImageAssetId] : null
  const job = jobFor(jobs, 'sheet', { characterId: c.id })
  const running = isRunning(job)
  const usedIn = clips.filter((cl) => cl.characterIds.includes(c.id)).length

  const generate = async (): Promise<void> => {
    try {
      await flush()
      await window.api.generate.characterSheet(c.id)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const upload = async (file: File | null): Promise<void> => {
    setUploading(true)
    try {
      await flushFlowProject(c.projectId)
      const asset = await window.api.flowImages.reference(c.projectId, c.id, file ? await imageFileBytes(file) : null)
      if (asset) useProject.getState().addAsset(asset)
      useProject.getState().applyCharacter(c.id, { referenceImageAssetId: asset?.id ?? null })
    } catch (e) { toast('error', errorText(e)) }
    finally { setUploading(false) }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Hapus pemeran ${c.name}?`,
      body: `Pemeran ini dipakai di ${usedIn} klip. Klip tetap ada, hanya tautan pemerannya yang dilepas.`,
      confirm: 'Hapus pemeran',
      danger: true
    })
    if (!ok) return
    removeCharacter(c.id)
    onClose()
  }

  return (
    <Modal open onClose={onClose} title="Lembar karakter" subtitle={`Dipakai di ${usedIn} klip sebagai referensi supaya tampilannya konsisten.`} width={760}>
      <div className="relative aspect-video overflow-hidden rounded-xl border-[1.5px] border-ink bg-paper">
        {sheet ? (
          <img src={sheet.url} alt={`Lembar karakter ${c.name}`} className="size-full object-contain" />
        ) : running ? null : (
          <div className="flex size-full flex-col items-center justify-center gap-3 text-ink-2">
            <span className="text-sm">Belum ada lembar karakter</span>
            <Button variant="accent" icon={<Sparkles className="size-4" />} disabled={running} onClick={() => void generate()}>
              Buat lembar karakter
            </Button>
          </div>
        )}
        {running && (
          <div
            className={cx(
              'absolute inset-0 flex flex-col items-center justify-center gap-2',
              sheet ? 'bg-paper/80 backdrop-blur-[3px]' : 'bg-paper'
            )}
          >
            <span className="text-sm font-semibold text-sun-ink">
              {job!.message ?? 'Memproses'}… {Math.round(job!.progress * 100)}%
            </span>
            <Progress value={job!.progress} className="w-1/2" />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[220px_minmax(0,1fr)] gap-4">
        <Field label="Nama">
          <input value={c.name} onChange={(e) => updateCharacter(c.id, { name: e.target.value })} className={cx(inputCls, 'h-11')} />
        </Field>
        <Field label="Penampilan" hint={LOOK_HINT}>
          <textarea
            rows={3}
            value={c.description}
            onChange={(e) => updateCharacter(c.id, { description: e.target.value })}
            className={cx(inputCls, 'resize-none py-2.5 text-sm leading-relaxed')}
          />
        </Field>
      </div>
      <ReferencePrompt value={c.referencePrompt} onChange={(referencePrompt) => updateCharacter(c.id, { referencePrompt })}
        onGenerate={() => updateCharacter(c.id, { referencePrompt: makeReferencePrompt(c.name, c.description) })} />
      <ReferenceFile onChange={(file) => { if (file) void upload(file) }} disabled={uploading} />
      {reference && (
        <div className="flex items-center gap-3">
          <img src={reference.url} alt={`Gambar referensi ${c.name}`} className="h-16 w-24 rounded bg-sand object-contain" />
          <Button size="sm" disabled={uploading} onClick={() => void upload(null)}>Hapus gambar referensi</Button>
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => void remove()}>
          Hapus pemeran
        </Button>
        <div className="flex-1" />
        {sheet && (
          <Button icon={<RefreshCw className="size-4" />} loading={running} onClick={() => void generate()}>
            Buat ulang lembar
          </Button>
        )}
        <Button variant="ink" onClick={onClose}>
          Selesai
        </Button>
      </div>
    </Modal>
  )
}

function ReferencePrompt({ value, onChange, onGenerate, disabled }: {
  value: string; onChange: (value: string) => void; onGenerate: () => void; disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-2 text-sm font-semibold">
        Prompt referensi Google Flow
        <textarea rows={3} value={value} disabled={disabled} className={cx(inputCls, 'py-2.5 text-sm')}
          onChange={(e) => onChange(e.target.value)} />
      </label>
      <Button size="sm" className="self-start" disabled={disabled} onClick={onGenerate}>Buat dari deskripsi</Button>
    </div>
  )
}

function ReferenceFile({ onChange, disabled }: { onChange: (file?: File) => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-2 text-sm font-semibold">
      Gambar referensi · JPG, PNG, atau WebP · maksimal 10 MB
      <input type="file" className={inputCls} accept={FLOW_IMAGE_ACCEPT} disabled={disabled}
        onChange={(e) => onChange(e.target.files?.[0])} />
    </label>
  )
}
