import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  HelpCircle,
  Image as ImageIcon,
  Sparkles
} from 'lucide-react'
import type { FlowExportSummary } from '@shared/types'
import { Button, Modal, Spinner, cx } from '../../components/ui'
import { clipNumber, errorText } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

export function FlowExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { project, flush } = useProject()
  const { toast } = useApp()
  const [data, setData] = useState<FlowExportSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [showGuide, setShowGuide] = useState(false)

  useEffect(() => {
    if (!open || !project) return
    let active = true
    setLoading(true)

    void flush().then(async () => {
      try {
        const res = await window.api.exporter.flowData(project.id)
        if (active) setData(res)
      } catch (err) {
        if (active) toast('error', errorText(err))
      } finally {
        if (active) setLoading(false)
      }
    })

    return () => {
      active = false
    }
  }, [open, project?.id])

  if (!project) return null

  const copyToClipboard = async (text: string, tag: string): Promise<void> => {
    try {
      await window.api.app.copyText(text)
      setCopied(tag)
      toast('success', 'Tersalin ke clipboard.')
      setTimeout(() => setCopied(null), 2000)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const downloadZip = (): void => {
    const a = document.createElement('a')
    a.href = `/api/export-flow?projectId=${encodeURIComponent(project.id)}`
    a.download = `${project.title || 'project'}_google_flow.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    toast('success', 'Unduhan paket Google Flow dimulai.')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ekspor Google Flow Automation"
      subtitle={`${project.title} · Rasio ${project.aspectRatio} · Otomasi bulk video Veo`}
      width={720}
    >
      {loading || !data ? (
        <div className="flex h-56 flex-col items-center justify-center gap-3 text-ink-2">
          <Spinner />
          <span className="text-sm">Menyiapkan daftar gambar dan prompt Google Flow…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Summary Banner */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 rounded-2xl border border-line bg-sand p-3.5">
            <div className="flex flex-col">
              <span className="text-xs text-muted">Total adegan</span>
              <span className="font-mono text-base font-semibold text-ink">{data.totalClips} klip</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted">Gambar adegan siap</span>
              <span className={cx('font-mono text-base font-semibold', data.readyClips === data.totalClips ? 'text-ok-ink' : 'text-accent-dark')}>
                {data.readyClips} dari {data.totalClips} klip
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted">Rasio tampilan</span>
              <span className="font-mono text-base font-semibold text-ink">{data.aspectRatio}</span>
            </div>
          </div>

          {data.readyClips < data.totalClips && (
            <div className="flex items-start gap-2.5 rounded-xl border border-sun bg-sun-soft px-3.5 py-2.5 text-[13px] text-sun-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Ada {data.totalClips - data.readyClips} klip yang belum punya gambar. Klip tanpa gambar tidak dapat disertakan sebagai frame awal video.
              </span>
            </div>
          )}

          {/* Quick Actions Bar */}
          <div className="flex flex-col gap-2 rounded-2xl border border-line bg-paper p-3.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">Aksi Cepat Salin Prompt</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={copied === 'txt' ? 'primary' : 'secondary'}
                icon={copied === 'txt' ? <Check className="size-3.5 text-ok-ink" /> : <FileText className="size-3.5" />}
                onClick={() => void copyToClipboard(data.promptsTxt, 'txt')}
                title="Satu baris per prompt adegan"
              >
                {copied === 'txt' ? 'Tersalin!' : 'Salin Semua Prompt (TXT)'}
              </Button>
              <Button
                size="sm"
                variant={copied === 'ref' ? 'primary' : 'secondary'}
                icon={copied === 'ref' ? <Check className="size-3.5 text-ok-ink" /> : <Sparkles className="size-3.5" />}
                onClick={() => void copyToClipboard(data.promptsWithRefTxt, 'ref')}
                title="Format dengan sintaks tag @gambar untuk ekstensi Auto Flow"
              >
                {copied === 'ref' ? 'Tersalin!' : 'Salin Tag Referensi (@gambar)'}
              </Button>
              <Button
                size="sm"
                variant={copied === 'csv' ? 'primary' : 'secondary'}
                icon={copied === 'csv' ? <Check className="size-3.5 text-ok-ink" /> : <FileSpreadsheet className="size-3.5" />}
                onClick={() => void copyToClipboard(data.csvText, 'csv')}
                title="Tabel CSV lengkap untuk ekstensi atau spreadsheet"
              >
                {copied === 'csv' ? 'Tersalin!' : 'Salin Format CSV'}
              </Button>
            </div>
          </div>

          {/* Guide Toggle */}
          <div className="rounded-xl border border-line-2 bg-surface">
            <button
              type="button"
              onClick={() => setShowGuide(!showGuide)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold text-ink-2 hover:text-ink"
            >
              <span className="flex items-center gap-1.5">
                <HelpCircle className="size-4 text-accent" />
                Cara pakai di ekstensi Google Flow Automation (Veo)
              </span>
              <span className="text-xs font-normal text-muted">{showGuide ? 'Sembunyikan' : 'Lihat panduan'}</span>
            </button>
            {showGuide && (
              <div className="border-t border-line-2 px-3.5 py-3 text-xs leading-relaxed text-ink-2">
                <ol className="list-decimal space-y-1.5 pl-4">
                  <li>
                    <strong>Unduh Paket .ZIP:</strong> Klik tombol hijau di bawah untuk mendapatkan seluruh gambar adegan yang telah bernomor rapi beserta file prompt (TXT, CSV, JSON).
                  </li>
                  <li>
                    <strong>Ekstrak file .ZIP</strong> di komputer kamu.
                  </li>
                  <li>
                    <strong>Buka Google Flow:</strong> Masuk ke <a href="https://flow.google.com" target="_blank" rel="noreferrer" className="text-accent-dark underline">flow.google.com</a> atau labs.google/fx di Google Chrome.
                  </li>
                  <li>
                    <strong>Buka ekstensi automation</strong> (misal: <em>Auto Flow</em>, <em>Flow Automation</em>, atau <em>AutoFlow Pro</em>).
                  </li>
                  <li>
                    Pilih mode <strong>Image to Video / Frames to Video</strong>, atur rasio ke <strong>{data.aspectRatio}</strong>, lalu masukkan gambar klip dan daftar prompt yang telah diekspor.
                  </li>
                  <li>
                    Jalankan otomasi untuk membuat video secara bulk.
                  </li>
                </ol>
              </div>
            )}
          </div>

          {/* Clips List Preview */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Pratinjau Adegan & Prompt ({data.items.length})</span>
              <span className="text-xs text-muted">Durasi video disesuaikan otomatis dengan panjang suara</span>
            </div>
            <div className="scroll-thin flex max-h-[280px] flex-col gap-2 overflow-y-auto pr-1">
              {data.items.map((item, idx) => {
                const isClipCopied = copied === item.clipId
                return (
                  <div
                    key={item.clipId}
                    className="flex items-start gap-3 rounded-xl border border-line bg-surface p-2.5 transition-colors hover:border-line-3"
                  >
                    {/* Thumbnail */}
                    <div className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-line-2 bg-sand">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.title} className="size-full object-cover" />
                      ) : (
                        <div className="flex size-full flex-col items-center justify-center text-muted">
                          <ImageIcon className="size-5" />
                          <span className="text-[10px]">No img</span>
                        </div>
                      )}
                      <span className="absolute bottom-0 left-0 right-0 bg-ink/70 text-center font-mono text-[10px] text-paper">
                        {item.durationSec}s
                      </span>
                    </div>

                    {/* Content */}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] font-bold text-paper">
                          {clipNumber(idx)}
                        </span>
                        <span className="truncate text-xs font-semibold text-ink">{item.title}</span>
                        <span className="text-[11px] font-mono text-muted">({item.imageFilename})</span>
                      </div>
                      <p className="line-clamp-2 text-xs leading-relaxed text-ink-2 select-text">
                        {item.videoPrompt || <span className="italic text-muted">Prompt gerak belum dibuat</span>}
                      </p>
                    </div>

                    {/* Copy single prompt */}
                    <button
                      type="button"
                      onClick={() => void copyToClipboard(item.videoPrompt, item.clipId)}
                      disabled={!item.videoPrompt}
                      title="Salin prompt adegan ini"
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-2 text-ink-2 transition hover:bg-sand hover:text-ink disabled:opacity-40"
                    >
                      {isClipCopied ? <Check className="size-3.5 text-ok-ink" /> : <Copy className="size-3.5" />}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-between border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Tutup
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                icon={<Download className="size-4" />}
                onClick={downloadZip}
              >
                Unduh Paket ZIP Google Flow
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
