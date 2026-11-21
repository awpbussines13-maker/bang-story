import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { makeZip, type ZipEntry } from './zipArchive'
import type { FlowExportItem, FlowExportSummary } from '@shared/types'
import { assetAbsPath, assetUrl } from './paths'
import { getBundle } from './repo'
import { sceneImageId } from '@shared/flowV2'
import { assertCharacterConsistency } from './characterConsistency'

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'clip'
  )
}

function escapeCsv(val: string | number): string {
  const str = String(val ?? '')
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function generateFlowData(projectId: string): FlowExportSummary {
  assertCharacterConsistency(projectId)
  const bundle = getBundle(projectId)
  const project = bundle.project
  const sortedClips = [...bundle.clips].sort((a, b) => a.sort - b.sort)

  const items: FlowExportItem[] = sortedClips.map((c, i) => {
    const idx = i + 1
    const padIdx = String(idx).padStart(2, '0')
    const titleSlug = slug(c.title || `clip_${idx}`)
    const imageAsset = bundle.assets.find((a) => a.id === sceneImageId(c)) ?? null
    const ext = imageAsset?.localPath ? extname(imageAsset.localPath) || '.png' : '.png'
    const imageFilename = `${padIdx}_${titleSlug}${ext}`
    const imageUrl = imageAsset ? assetUrl(projectId, imageAsset.localPath) : null

    // Video motion prompt: prioritize videoPrompt, then visualPrompt, then story
    const rawPrompt = c.videoPrompt?.trim() || c.visualPrompt?.trim() || c.story?.trim() || ''
    const videoPrompt = rawPrompt.replace(/[\r\n]+/g, ' ').trim()
    const durationSec = Math.max(4, Math.round((c.durationMs || 5000) / 1000))

    return {
      index: idx,
      clipId: c.id,
      title: c.title || `Klip ${idx}`,
      imageFilename,
      imageUrl,
      hasImage: !!imageAsset,
      videoPrompt,
      durationSec,
      aspectRatio: project.aspectRatio
    }
  })

  const readyClips = items.filter((it) => it.hasImage).length

  // Universal TXT prompt list (1 per line)
  const promptsTxt = items.map((it) => it.videoPrompt).join('\n')

  // Prompts with reference image syntax for Auto Flow extensions
  const promptsWithRefTxt = items.map((it) => `@${it.imageFilename} [${it.durationSec}s] ${it.videoPrompt}`).join('\n')

  // Standard CSV format
  const csvHeaders = ['clip', 'title', 'image', 'prompt', 'duration_sec', 'aspect_ratio']
  const csvRows = items.map((it) =>
    [
      it.index,
      escapeCsv(it.title),
      escapeCsv(it.imageFilename),
      escapeCsv(it.videoPrompt),
      it.durationSec,
      escapeCsv(it.aspectRatio)
    ].join(',')
  )
  const csvText = [csvHeaders.join(','), ...csvRows].join('\n')

  // TSV format
  const tsvHeaders = ['clip', 'title', 'image', 'prompt', 'duration_sec', 'aspect_ratio']
  const tsvRows = items.map((it) =>
    [
      it.index,
      it.title.replace(/\t/g, ' '),
      it.imageFilename,
      it.videoPrompt.replace(/\t/g, ' '),
      it.durationSec,
      it.aspectRatio
    ].join('\t')
  )
  const tsvText = [tsvHeaders.join('\t'), ...tsvRows].join('\n')

  // JSON queue format
  const jsonText = JSON.stringify(items, null, 2)

  return {
    projectId,
    title: project.title,
    aspectRatio: project.aspectRatio,
    totalClips: items.length,
    readyClips,
    items,
    promptsTxt,
    promptsWithRefTxt,
    csvText,
    tsvText,
    jsonText
  }
}

export function buildFlowZip(projectId: string): { zipBuffer: Buffer; fileName: string } {
  const bundle = getBundle(projectId)
  const data = generateFlowData(projectId)
  const entries: ZipEntry[] = []

  // Add images that exist on disk
  for (const item of data.items) {
    if (!item.hasImage) continue
    const clip = bundle.clips.find((c) => c.id === item.clipId)
    const asset = clip ? bundle.assets.find((a) => a.id === sceneImageId(clip)) : null
    if (!asset) continue

    const abs = assetAbsPath(projectId, asset.localPath)
    if (existsSync(abs)) {
      try {
        const buf = readFileSync(abs)
        // Store images uncompressed (method 0) for maximum speed and compatibility
        entries.push({ name: item.imageFilename, data: buf, compress: false })
      } catch (err) {
        console.warn(`[FlowExport] Gagal membaca gambar ${abs}:`, err)
      }
    }
  }

  // Guide in Indonesian
  const guideText = `================================================================
PANDUAN EKSPOR GOOGLE FLOW AUTOMATION (VEO)
================================================================
Proyek       : ${data.title}
Rasio Aspek  : ${data.aspectRatio}
Total Klip   : ${data.totalClips}
Klip Bergambar: ${data.readyClips}

FILE DALAM PAKET INI:
--------------------
1. File Gambar (*.png / *.jpg)
   Gambar adegan/frame awal untuk tiap klip, diurutkan bernomor:
   01_judul.png, 02_judul.png, dst.

2. google_flow_prompts.txt
   Daftar prompt gerak video (1 baris per klip). Format paling universal
   untuk ditempel langsung ke kolom antrean ekstensi Google Flow.

3. google_flow_reference_prompts.txt
   Daftar prompt dengan tag referensi gambar (@nama_gambar) dan durasi [X s].
   Cocok untuk ekstensi yang mendukung auto-assign gambar referensi.

4. google_flow_automation.csv
   Format tabel CSV lengkap (clip, title, image, prompt, duration_sec, aspect_ratio).
   Dapat diimpor ke tools otomasi atau dibuka di Google Sheets/Excel.

5. google_flow_automation.tsv
   Format Tab-Separated Values untuk kemudahan copy-paste ke spreadsheet.

6. google_flow_queue.json
   Format data JSON terstruktur untuk otomasi API / custom script.

CARA PENGGUNAAN DI GOOGLE FLOW:
-------------------------------
1. Buka Google Flow (https://flow.google.com atau https://labs.google/fx) di Chrome.
2. Pasang dan aktifkan ekstensi otomasi Google Flow (contoh: Auto Flow, Flow Automation, atau AutoFlow Pro).
3. Pilih mode 'Image to Video' atau 'Frames to Video' (Veo).
4. Atur Rasio Aspek ke ${data.aspectRatio}.
5. Unggah gambar-gambar klip dari folder ini sebagai referensi atau frame awal.
6. Masukkan prompt dari google_flow_prompts.txt atau impor file google_flow_automation.csv.
7. Jalankan bulk automation untuk membuat video AI secara otomatis.
`

  // Add text/metadata files (deflated)
  entries.push({ name: 'google_flow_prompts.txt', data: Buffer.from(data.promptsTxt, 'utf8'), compress: true })
  entries.push({ name: 'google_flow_reference_prompts.txt', data: Buffer.from(data.promptsWithRefTxt, 'utf8'), compress: true })
  entries.push({ name: 'google_flow_automation.csv', data: Buffer.from(data.csvText, 'utf8'), compress: true })
  entries.push({ name: 'google_flow_automation.tsv', data: Buffer.from(data.tsvText, 'utf8'), compress: true })
  entries.push({ name: 'google_flow_queue.json', data: Buffer.from(data.jsonText, 'utf8'), compress: true })
  entries.push({ name: 'PANDUAN_GOOGLE_FLOW.txt', data: Buffer.from(guideText, 'utf8'), compress: true })

  const zipBuffer = makeZip(entries)
  const fileName = `${slug(data.title)}_google_flow_export.zip`

  return { zipBuffer, fileName }
}
