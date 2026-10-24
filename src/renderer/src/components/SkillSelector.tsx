import { useEffect, useState } from 'react'
import { Plus, Settings2, Trash2 } from 'lucide-react'
import type { Skill } from '@shared/types'
import { Select, type SelectOption } from './Select'
import { Button, IconButton, Modal, cx } from './ui'

interface Props {
  value: string | null
  onChange: (skillId: string | null) => void
  variant?: 'pill' | 'field'
  className?: string
}

export function SkillSelector({ value, onChange, variant = 'pill', className }: Props) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<{ id?: string; name: string; prompt: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const reloadSkills = async () => {
    try {
      const list = await window.api.skills.list()
      setSkills(list)
    } catch (err) {
      console.error('Failed to load skills', err)
    }
  }

  useEffect(() => {
    void reloadSkills()
  }, [])

  const options: SelectOption<string>[] = [
    { value: '', label: 'Tanpa skill (Bawaan)', hint: 'Alur cerita standar' },
    ...skills.map((s) => ({
      value: s.id,
      label: s.name,
      hint: s.prompt ? (s.prompt.length > 30 ? s.prompt.slice(0, 30) + '…' : s.prompt) : undefined
    }))
  ]

  const handleSaveSkill = async () => {
    if (!editingSkill || !editingSkill.name.trim()) return
    setSaving(true)
    try {
      if (editingSkill.id) {
        await window.api.skills.update(editingSkill.id, {
          name: editingSkill.name,
          prompt: editingSkill.prompt
        })
      } else {
        const created = await window.api.skills.create({
          name: editingSkill.name,
          prompt: editingSkill.prompt
        })
        onChange(created.id)
      }
      await reloadSkills()
      setEditingSkill(null)
    } catch (err) {
      console.error('Error saving skill', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteSkill = async (id: string) => {
    try {
      await window.api.skills.remove(id)
      if (value === id) onChange(null)
      await reloadSkills()
      if (editingSkill?.id === id) setEditingSkill(null)
    } catch (err) {
      console.error('Error deleting skill', err)
    }
  }

  return (
    <>
      <div className={cx('inline-flex items-center gap-1.5', className)}>
        <Select
          variant={variant}
          label="Skill naskah"
          value={value || ''}
          onChange={(v) => onChange(v ? v : null)}
          options={options}
          menuWidth={280}
        />
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          title="Kelola & Tambah Skill Naskah"
          className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line-2 bg-surface px-3 text-xs font-semibold text-ink-2 hover:border-ink hover:text-ink transition-colors"
        >
          <Settings2 className="size-3.5" />
          <span className="hidden sm:inline">Kelola Skill</span>
        </button>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
          setEditingSkill(null)
        }}
        title="Skill Naskah Cerita"
        subtitle="Instruksi khusus atau gaya penceritaan yang akan diikuti AI saat menyusun naskah adegan."
        width={640}
      >
        <div className="flex flex-col gap-5">
          {editingSkill ? (
            <div className="flex flex-col gap-3 rounded-xl border border-line-2 bg-paper p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-ink">
                  {editingSkill.id ? 'Edit Skill' : 'Tambah Skill Baru'}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingSkill(null)}
                  className="text-xs text-muted hover:text-ink"
                >
                  Batal
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-2">Nama Skill</label>
                <input
                  type="text"
                  placeholder="Contoh: Horor Misterius, Komedi Sarkas, Edukasi Cepat"
                  value={editingSkill.name}
                  onChange={(e) => setEditingSkill({ ...editingSkill, name: e.target.value })}
                  className="h-10 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink outline-none focus:border-ink"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-2">Prompt / Instruksi Khusus Naskah</label>
                <textarea
                  rows={4}
                  placeholder="Instruksi detail, misal: Gunakan gaya bercerita misterius dengan kalimat pendek menggantung. Buat narasi terasa mencekam dan tambahkan jeda <short pause> untuk ketegangan..."
                  value={editingSkill.prompt}
                  onChange={(e) => setEditingSkill({ ...editingSkill, prompt: e.target.value })}
                  className="rounded-lg border border-line-2 bg-surface p-3 text-sm text-ink outline-none focus:border-ink resize-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="ghost" onClick={() => setEditingSkill(null)}>
                  Batal
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={saving}
                  disabled={!editingSkill.name.trim()}
                  onClick={() => void handleSaveSkill()}
                >
                  Simpan Skill
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-ink">Daftar Skill Tersimpan</span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setEditingSkill({ name: '', prompt: '' })}
              >
                <Plus className="size-4" />
                Tambah Skill Baru
              </Button>
            </div>
          )}

          <div className="flex flex-col divide-y divide-line-2 rounded-xl border border-line-2 bg-surface max-h-[320px] overflow-y-auto">
            {skills.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                Belum ada skill yang disimpan. Buat skill pertama kamu agar ide cerita sesuai gaya yang kamu mau!
              </div>
            ) : (
              skills.map((s) => (
                <div key={s.id} className="flex items-start justify-between gap-3 p-3.5 hover:bg-paper/50">
                  <div className="flex flex-col gap-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-ink">{s.name}</span>
                      {value === s.id && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                          Aktif Dipilih
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-2 line-clamp-2">{s.prompt || 'Tidak ada instruksi prompt tambahan.'}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingSkill({ id: s.id, name: s.name, prompt: s.prompt })}
                    >
                      Edit
                    </Button>
                    <IconButton
                      label="Hapus"
                      onClick={() => void handleDeleteSkill(s.id)}
                      className="text-red-500 hover:text-red-700"
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}
