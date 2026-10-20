import { readFileSync } from 'node:fs'

/**
 * Text widths from a TrueType file's own tables (cmap + hmtx), so the export can size the rounded box
 * behind a caption the way libass lays out the text. Kerning is ignored; the box padding absorbs it.
 */

type Measure = (text: string) => number

const cache = new Map<string, Measure>()

function tables(b: Buffer): Record<string, number> {
  const out: Record<string, number> = {}
  const n = b.readUInt16BE(4)
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    out[b.toString('latin1', o, o + 4)] = b.readUInt32BE(o + 8)
  }
  return out
}

/** Unicode code point → glyph id, from a format 4 or 12 cmap subtable. */
function readCmap(b: Buffer, at: number): (cp: number) => number {
  const count = b.readUInt16BE(at + 2)
  let best: { format: number; off: number } | null = null
  for (let i = 0; i < count; i++) {
    const r = at + 4 + i * 8
    const platform = b.readUInt16BE(r)
    const encoding = b.readUInt16BE(r + 2)
    const off = at + b.readUInt32BE(r + 4)
    const format = b.readUInt16BE(off)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode || (format !== 4 && format !== 12)) continue
    if (!best || format === 12) best = { format, off }
  }
  if (!best) return () => 0
  const { format, off } = best
  if (format === 12) {
    const groups = b.readUInt32BE(off + 12)
    return (cp) => {
      for (let i = 0; i < groups; i++) {
        const g = off + 16 + i * 12
        const start = b.readUInt32BE(g)
        const end = b.readUInt32BE(g + 4)
        if (cp >= start && cp <= end) return b.readUInt32BE(g + 8) + (cp - start)
      }
      return 0
    }
  }
  const segs = b.readUInt16BE(off + 6) / 2
  const ends = off + 14
  const starts = ends + segs * 2 + 2
  const deltas = starts + segs * 2
  const ranges = deltas + segs * 2
  return (cp) => {
    if (cp > 0xffff) return 0
    for (let i = 0; i < segs; i++) {
      if (cp > b.readUInt16BE(ends + i * 2)) continue
      const start = b.readUInt16BE(starts + i * 2)
      if (cp < start) return 0
      const delta = b.readInt16BE(deltas + i * 2)
      const rangeAt = ranges + i * 2
      const range = b.readUInt16BE(rangeAt)
      if (range === 0) return (cp + delta) & 0xffff
      const g = b.readUInt16BE(rangeAt + range + (cp - start) * 2)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
}

/** A function giving a string's advance width in ems for the font file. */
export function fontMeasure(file: string): Measure {
  return fontChain([file])
}

/**
 * Advance widths for a font stack: characters the first file lacks are measured with the next one, which is
 * how libass picks a fallback face (e.g. Arabic captions drawn with Noto Naskh over a Latin caption font).
 */
export function fontChain(files: string[]): Measure {
  const key = files.join('|')
  const hit = cache.get(key)
  if (hit) return hit
  const faces = files.map((f) => loadFace(f))
  const widths = new Map<number, number>()
  const width = (cp: number): number => {
    let w = widths.get(cp)
    if (w === undefined) {
      const face = faces.find((f) => f.glyphOf(cp) !== 0)
      w = face ? face.advance(face.glyphOf(cp)) / face.upm : 0.55
      widths.set(cp, w)
    }
    return w
  }
  const measure: Measure = (text) => {
    let sum = 0
    for (const ch of text) sum += width(ch.codePointAt(0)!)
    return sum
  }
  cache.set(key, measure)
  return measure
}

interface Face {
  upm: number
  advance: (glyph: number) => number
  glyphOf: (cp: number) => number
}

function loadFace(file: string): Face {
  const b = readFileSync(file)
  const t = tables(b)
  const upm = b.readUInt16BE(t.head + 18)
  const metrics = b.readUInt16BE(t.hhea + 34)
  const glyphOf = readCmap(b, t.cmap)
  return { upm, glyphOf, advance: (g) => b.readUInt16BE(t.hmtx + Math.min(g, metrics - 1) * 4) }
}
