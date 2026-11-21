import { useState } from 'react'
import { FLOW_IMAGE_ACCEPT, FLOW_IMAGE_LIMIT, FLOW_ZIP_LIMIT, sceneImageId, type FlowImageChange, type FlowImportPreview } from '@shared/flowV2'
import type { ImageFit } from '@shared/types'
import { Select } from '../../components/Select'
import { Button, Modal, Segmented, confirmDialog, inputCls } from '../../components/ui'
import { errorText } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

export async function flushFlowProject(projectId: string): Promise<void> {
  await useProject.getState().flush()
  const state = useProject.getState()
  if (state.project?.id !== projectId) throw new Error('Proyek sudah berganti.')
  if (state.saveState === 'error') throw new Error(state.saveError ?? 'Proyek gagal disimpan.')
}

export async function exportForFlow(projectId: string): Promise<void> {
  await flushFlowProject(projectId)
  const empty = await window.api.flowImages.exportSummary(projectId)
  if (empty.length && !await confirmDialog({
    title: 'Ekspor untuk Google Flow',
    body: `${empty.join(', ')} tidak memakai karakter. Lanjutkan?`,
    confirm: 'Lanjutkan', cancel: 'Batal'
  })) return
  await window.api.flowImages.exportZip(projectId, empty.length > 0)
}

export function applyImageChange(projectId: string, change: FlowImageChange): void {
  const state = useProject.getState()
  if (state.project?.id !== projectId) return
  if (change.asset) state.addAsset(change.asset)
  state.applyClip(change.clipId, { importedImageAssetId: change.asset?.id ?? null, imageFit: change.imageFit })
}

export function ImageFraming({ fit, onChange, disabled }: { fit: ImageFit; onChange: (fit: ImageFit) => void; disabled?: boolean }) {
  return <Segmented value={fit} onChange={onChange} size="sm" options={[
    { id: 'cover', label: 'Isi (crop)', disabled }, { id: 'contain', label: 'Muat (letterbox)', disabled }
  ]} />
}

export async function imageFileBytes(file: File): Promise<ArrayBuffer> {
  if (!file.size || file.size > FLOW_IMAGE_LIMIT) throw new Error('Ukuran gambar maksimal 10 MB.')
  return file.arrayBuffer()
}

export function SceneImageImport({ projectId, clipId, droppedFile, initialFit, onClose }: {
  projectId: string; clipId: string; droppedFile?: File; initialFit: ImageFit; onClose: () => void
}) {
  const [file, setFile] = useState(droppedFile)
  const [url, setUrl] = useState('')
  const [fit, setFit] = useState(initialFit)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { toast } = useApp()
  async function apply() {
    setBusy(true)
    setError('')
    try {
      await flushFlowProject(projectId)
      const api = window.api.flowImages
      const result = file ? await api.importImage(projectId, clipId, await imageFileBytes(file), fit)
        : await api.importUrl(projectId, clipId, url.trim(), fit)
      applyImageChange(projectId, result)
      toast('success', 'Gambar diimpor.')
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally { setBusy(false) }
  }
  return (
    <Modal open title="Impor gambar" onClose={() => { if (!busy) onClose() }}>
      <label className="flex flex-col gap-2 text-sm font-semibold">
        File JPG, PNG, atau WebP · maksimal 10 MB
        <input type="file" accept={FLOW_IMAGE_ACCEPT} disabled={busy} className={inputCls}
          onChange={(e) => { const next = e.target.files?.[0]; setFile(next); if (next) setUrl('') }} />
      </label>
      {file && <span className="text-sm break-all">{file.name}</span>}
      <label className="flex flex-col gap-2 text-sm font-semibold">
        URL gambar HTTPS atau tautan Google Drive publik
        <input type="url" value={url} disabled={busy} className={inputCls} placeholder="https://"
          onChange={(e) => { setUrl(e.target.value); setFile(undefined) }} />
      </label>
      <ImageFraming fit={fit} onChange={setFit} disabled={busy} />
      {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose}>Batal</Button>
        <Button variant="primary" loading={busy} disabled={busy || (!file && !url.trim())} onClick={() => void apply()}>Impor gambar</Button>
      </div>
    </Modal>
  )
}

export function ZipImageImport({ projectId, onClose, onMissing }: {
  projectId: string; onClose: () => void; onMissing: (clipId: string) => void
}) {
  const [preview, setPreview] = useState<FlowImportPreview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ applied: number; remaining: FlowImportPreview['scenes'] } | null>(null)
  const [fit, setFit] = useState<ImageFit>('cover')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = Object.entries(mapping).filter(([, clipId]) => clipId)

  async function inspect(file: File) {
    setBusy(true)
    setPreview(null)
    setError('')
    try {
      if (!file.size || file.size > FLOW_ZIP_LIMIT) throw new Error('Ukuran ZIP maksimal 96 MB.')
      await flushFlowProject(projectId)
      const next = await window.api.flowImages.previewZip(projectId, await file.arrayBuffer())
      setMapping(Object.fromEntries(next.images.map((image) => [image.name, image.clipId ?? ''])))
      setPreview(next)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  async function apply() {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      await flushFlowProject(projectId)
      const changes = await window.api.flowImages.applyZip(projectId, preview.token, selected.map(([image, clipId]) => ({ clipId, image })), fit)
      for (const change of changes) applyImageChange(projectId, change)
      const missing = new Set(useProject.getState().clips.filter((c) => !sceneImageId(c)).map((c) => c.id))
      setResult({ applied: changes.length, remaining: preview.scenes.filter((s) => missing.has(s.id)) })
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  return (
    <Modal open width={820} title="Impor gambar dari ZIP" onClose={() => { if (!busy) onClose() }}>
      {result && preview ? (
        <>
          <p role="status">{result.applied} dari {preview.scenes.length} klip mendapat gambar{result.remaining.length ? ' — masih perlu gambar:' : '.'}</p>
          {result.remaining.map((scene) => (
            <div key={scene.id} className="flex items-center justify-between gap-2">
              <span className="text-sm break-all">{scene.label}</span>
              <Button size="sm" onClick={() => onMissing(scene.id)}>Impor gambar</Button>
            </div>
          ))}
        </>
      ) : (
        <>
          <label className="flex flex-col gap-2 text-sm font-semibold">
            ZIP hasil Download All Scenes
            <input type="file" aria-label="ZIP hasil Download All Scenes" accept=".zip" className={inputCls} disabled={busy}
              onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void inspect(file) }} />
          </label>
          {busy && !preview && <p role="status" className="text-sm">Menyiapkan pratinjau gambar…</p>}
          {preview && (
            <>
              <table className="w-full table-fixed text-left text-sm">
                <thead><tr><th className="w-[78px] pb-2">Gambar</th><th className="w-[37%] pb-2">Nama file</th><th className="pb-2">Klip tujuan</th></tr></thead>
                <tbody>
                  {preview.images.map((image) => (
                    <tr key={image.name} className="border-t border-line">
                      <td className="py-2 pr-2"><img alt="" src={image.thumbnail} className="h-12 w-full rounded bg-sand object-contain" /></td>
                      <th scope="row" className="break-all py-2 pr-2 font-medium">
                        {image.name}
                        {!mapping[image.name] && <span className="mt-1 block text-xs text-sun-ink">
                          {image.clipId ? 'Tidak dipetakan' : 'Belum cocok otomatis'}
                        </span>}
                      </th>
                      <td className="py-2">
                        <Select label={`Klip tujuan untuk ${image.name}`} size="sm" value={mapping[image.name] ?? ''} disabled={busy}
                          options={[{ value: '', label: 'Lewati file' }, ...preview.scenes.map((scene) => ({ value: scene.id, label: scene.label }))]}
                          onChange={(clipId) => setMapping((previous) => ({
                            ...Object.fromEntries(Object.entries(previous).map(([name, current]) => [name, clipId && current === clipId ? '' : current])),
                            [image.name]: clipId
                          }))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ImageFraming fit={fit} onChange={setFit} disabled={busy} />
            </>
          )}
        </>
      )}
      {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>{result ? 'Selesai' : 'Batal'}</Button>
        {preview && !result && <Button variant="primary" loading={busy} disabled={busy || !selected.length} onClick={() => void apply()}>Terapkan</Button>}
      </div>
    </Modal>
  )
}
