import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList } from 'node:net'
import { FLOW_IMAGE_LIMIT } from '@shared/flowV2'

const nonPublic = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) nonPublic.addSubnet(address, prefix)

export async function fetchFlowImage(raw: string): Promise<Buffer> {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.trim()) throw new Error('Masukkan URL gambar HTTPS.')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Masukkan URL gambar HTTPS yang valid.') }
  if (url.origin === 'https://drive.google.com') {
    const id = /^\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id')
    if (id && /^[\w-]+$/.test(id)) url = new URL(`https://drive.google.com/uc?export=download&id=${id}`)
  }
  const signal = AbortSignal.timeout(15000)
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Gunakan URL gambar HTTPS publik.')
    // Pin the validated IPv4 address while preserving the original TLS hostname on every hop.
    const { address } = await lookup(url.hostname, { family: 4 })
    if (nonPublic.check(address)) throw new Error('Gunakan URL gambar HTTPS publik.')
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request(url, { family: 4, signal, lookup: (_host, _options, cb) => cb(null, address, 4) }, resolve)
      req.on('error', reject)
      req.end()
    })
    const status = response.statusCode ?? 0
    const location = response.headers.location
    if (status >= 300 && status < 400 && location) {
      response.destroy()
      url = new URL(location, url)
      continue
    }
    if (status !== 200 || Number(response.headers['content-length']) > FLOW_IMAGE_LIMIT) {
      response.destroy()
      throw new Error(status === 200 ? 'Ukuran gambar maksimal 10 MB.' : 'URL gambar tidak bisa diunduh. Pastikan tautannya publik.')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      size += chunk.length
      if (size > FLOW_IMAGE_LIMIT) throw new Error('Ukuran gambar maksimal 10 MB.')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  }
  throw new Error('URL gambar terlalu banyak dialihkan.')
}
