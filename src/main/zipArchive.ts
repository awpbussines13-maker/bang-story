import { inflateRawSync, crc32, deflateRawSync } from 'node:zlib'
import { posix } from 'node:path'

export interface ZipEntry {
  name: string
  data: Buffer
  compress?: boolean
}

export interface ZipReadLimits {
  maxTotalBytes?: number
  maxEntries?: number
  maxManifestBytes?: number
  maxEntryBytes?: number
}

/** Builds an in-memory PKZIP archive using Node standard library only. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const cdParts: Buffer[] = []
  let offset = 0

  for (const { name, data, compress } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const compMethod = compress ? 8 : 0
    const comp = compress ? deflateRawSync(data) : data
    const crc = crc32(data)

    // Local file header (30 bytes)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // version needed: 2.0
    lh.writeUInt16LE(0x0800, 6) // bit 11 = UTF-8 filename
    lh.writeUInt16LE(compMethod, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)

    parts.push(lh, nameBuf, comp)

    // Central directory header (46 bytes)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8) // bit 11 = UTF-8
    cd.writeUInt16LE(compMethod, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra len
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt16LE(0, 34) // disk start
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // relative offset of local header

    cdParts.push(cd, nameBuf)
    offset += lh.length + nameBuf.length + comp.length
  }

  const cdOffset = offset
  const cdBuf = Buffer.concat(cdParts)

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, cdBuf, eocd])
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

function checkExtraFields(data: Buffer, start: number, length: number): void {
  const end = start + length
  if (end > data.length) throw new Error('ZIP entry has truncated extra fields')
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) throw new Error('ZIP entry has a malformed extra field')
    const id = data.readUInt16LE(offset)
    const size = data.readUInt16LE(offset + 2)
    offset += 4
    if (offset + size > end) throw new Error('ZIP entry has a malformed extra field')
    if (id === 0x0001) throw new Error('ZIP64 archives are unsupported')
    offset += size
  }
}

function safeEntryName(bytes: Buffer): string {
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('ZIP entry filename is not valid UTF-8')
  }
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name))
    throw new Error(`Unsafe ZIP entry path: ${name}`)
  if (name.split('/').some((part) => part === '..')) throw new Error(`Unsafe ZIP entry path: ${name}`)
  const normalized = posix.normalize(name)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized))
    throw new Error(`Unsafe ZIP entry path: ${name}`)
  return normalized
}

/** Reads store/deflate ZIP entries with bounded expansion and strict path/header validation. */
export function readZipArchive(data: Buffer, limits: ZipReadLimits = {}): Map<string, Buffer> {
  const maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024
  const maxEntries = limits.maxEntries ?? 4096
  const maxManifestBytes = limits.maxManifestBytes ?? 16 * 1024 * 1024
  const maxEntryBytes = limits.maxEntryBytes ?? 32 * 1024 * 1024
  for (const [name, value] of Object.entries({ maxTotalBytes, maxEntries, maxManifestBytes, maxEntryBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ZIP read limit: ${name}`)
  }
  if (data.length < 22) throw new Error('Invalid ZIP: missing end of central directory')

  const minEocd = Math.max(0, data.length - 22 - UINT16_MAX)
  let eocdOffset = -1
  for (let offset = data.length - 22; offset >= minEocd; offset--) {
    if (data.readUInt32LE(offset) !== EOCD) continue
    const commentLength = data.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === data.length) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP: missing or malformed end of central directory')

  const disk = data.readUInt16LE(eocdOffset + 4)
  const centralDisk = data.readUInt16LE(eocdOffset + 6)
  const diskEntries = data.readUInt16LE(eocdOffset + 8)
  const entryCount = data.readUInt16LE(eocdOffset + 10)
  const centralSize = data.readUInt32LE(eocdOffset + 12)
  const centralOffset = data.readUInt32LE(eocdOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error('Multi-disk ZIP archives are unsupported')
  if (diskEntries === UINT16_MAX || entryCount === UINT16_MAX || centralSize === UINT32_MAX || centralOffset === UINT32_MAX)
    throw new Error('ZIP64 archives are unsupported')
  if (entryCount > maxEntries) throw new Error('ZIP entry count exceeds configured limit')
  if (centralOffset + centralSize !== eocdOffset) throw new Error('Invalid ZIP central directory bounds')

  const entries: Array<{
    name: string
    rawName: Buffer
    flags: number
    method: number
    crc: number
    compressedSize: number
    uncompressedSize: number
    localOffset: number
  }> = []
  const normalizedNames = new Set<string>()
  let offset = centralOffset
  let totalSize = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocdOffset || data.readUInt32LE(offset) !== CENTRAL) throw new Error('Invalid ZIP central directory entry')
    const versionNeeded = data.readUInt16LE(offset + 6)
    const flags = data.readUInt16LE(offset + 8)
    const method = data.readUInt16LE(offset + 10)
    const crc = data.readUInt32LE(offset + 16)
    const compressedSize = data.readUInt32LE(offset + 20)
    const uncompressedSize = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const diskStart = data.readUInt16LE(offset + 34)
    const localOffset = data.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > eocdOffset) throw new Error('Truncated ZIP central directory entry')
    if (versionNeeded >= 45 || compressedSize === UINT32_MAX || uncompressedSize === UINT32_MAX || localOffset === UINT32_MAX)
      throw new Error('ZIP64 archives are unsupported')
    if (diskStart !== 0) throw new Error('Multi-disk ZIP archives are unsupported')
    if (flags & (0x0001 | 0x0040 | 0x2000)) throw new Error('Encrypted ZIP entries are unsupported')
    if (flags & ~(0x080e | 0x0800)) throw new Error('ZIP entry uses unsupported flags')
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}`)

    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength)
    const name = safeEntryName(nameBytes)
    if (normalizedNames.has(name)) throw new Error(`Duplicate ZIP entry path: ${name}`)
    normalizedNames.add(name)
    checkExtraFields(data, offset + 46 + nameLength, extraLength)

    const perEntryLimit = name === 'manifest.json' ? maxManifestBytes : maxEntryBytes
    if (uncompressedSize > perEntryLimit) throw new Error(`ZIP entry exceeds size limit: ${name}`)
    totalSize += uncompressedSize
    if (!Number.isSafeInteger(totalSize) || totalSize > maxTotalBytes) throw new Error('ZIP expanded size exceeds configured limit')

    entries.push({ name, rawName: nameBytes, flags, method, crc, compressedSize, uncompressedSize, localOffset })
    offset = end
  }
  if (offset !== eocdOffset) throw new Error('ZIP central directory entry count or size mismatch')

  const files = new Map<string, Buffer>()
  const spans: Array<[number, number]> = []
  for (const entry of entries) {
    const { name, rawName, flags, method, crc, compressedSize, uncompressedSize, localOffset } = entry
    if (localOffset + 30 > centralOffset || data.readUInt32LE(localOffset) !== LOCAL) throw new Error('Invalid ZIP local file header')
    const localFlags = data.readUInt16LE(localOffset + 6)
    const localMethod = data.readUInt16LE(localOffset + 8)
    const localCrc = data.readUInt32LE(localOffset + 14)
    const localCompressedSize = data.readUInt32LE(localOffset + 18)
    const localUncompressedSize = data.readUInt32LE(localOffset + 22)
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + compressedSize
    if (localFlags !== flags || localMethod !== method) throw new Error('ZIP local and central headers disagree')
    if (dataEnd > centralOffset || dataEnd < dataOffset) throw new Error('ZIP entry data exceeds archive bounds')
    const hasDataDescriptor = !!(flags & 0x0008)
    if (localCrc === UINT32_MAX || localCompressedSize === UINT32_MAX || localUncompressedSize === UINT32_MAX)
      throw new Error('ZIP64 archives are unsupported')
    if ((!hasDataDescriptor && (localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) ||
      (hasDataDescriptor && ((localCrc && localCrc !== crc) || (localCompressedSize && localCompressedSize !== compressedSize) || (localUncompressedSize && localUncompressedSize !== uncompressedSize))))
      throw new Error('ZIP local and central headers disagree')
    const localName = data.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    if (!localName.equals(rawName)) throw new Error('ZIP local and central filenames disagree')
    checkExtraFields(data, localOffset + 30 + localNameLength, localExtraLength)
    let spanEnd = dataEnd
    if (hasDataDescriptor) {
      let descriptorOffset = dataEnd
      if (descriptorOffset + 4 <= centralOffset && data.readUInt32LE(descriptorOffset) === 0x08074b50) descriptorOffset += 4
      if (descriptorOffset + 12 > centralOffset) throw new Error('Truncated ZIP data descriptor')
      if (data.readUInt32LE(descriptorOffset) !== crc || data.readUInt32LE(descriptorOffset + 4) !== compressedSize || data.readUInt32LE(descriptorOffset + 8) !== uncompressedSize)
        throw new Error('ZIP data descriptor disagrees with central directory')
      spanEnd = descriptorOffset + 12
    }
    spans.push([localOffset, spanEnd])

    const compressed = data.subarray(dataOffset, dataEnd)
    let content: Buffer
    try {
      content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) })
    } catch {
      throw new Error(`Corrupt or oversized ZIP data: ${name}`)
    }
    if (content.length !== uncompressedSize) throw new Error(`ZIP uncompressed size mismatch: ${name}`)
    if (crc32(content) !== crc) throw new Error(`ZIP CRC mismatch: ${name}`)
    files.set(name, content)
  }
  spans.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < spans.length; index++) {
    if (spans[index][0] < spans[index - 1][1]) throw new Error('Overlapping ZIP local entries are unsupported')
  }
  return files
}
