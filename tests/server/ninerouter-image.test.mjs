import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mock, test } from 'node:test'
import { build } from 'esbuild'
import ffmpegStatic from 'ffmpeg-static'

const bundle = await build({
  entryPoints: ['src/main/services/ninerouter.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', alias: { '@shared': resolve('src/shared') },
  plugins: [{ name: 'image-test-settings', setup(build) {
    build.onResolve({ filter: /^ffmpeg-static$/ }, () => ({ path: 'ffmpeg', namespace: 'test' }))
    build.onResolve({ filter: /^\.\.\/(settings|secrets|paths)$/ }, ({ path }) => ({ path, namespace: 'test' }))
    build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'ffmpeg' ? 'export default ' + JSON.stringify(ffmpegStatic) : path.endsWith('settings')
      ? 'export const getSettings = () => ({nineRouterBaseUrl:"http://router.test/v1",nineRouterTtsModel:"gemini/gemini-3.8-flash-tts"})'
      : path.endsWith('paths') ? 'export const binPath = value => value' : 'export const getSecret = () => ""' }))
  } }]
})
const { generateImage, speak, listVoices } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('9Router exposes Gemini characters under their model and retains legacy selections', async () => {
  const fetch = mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'http://router.test/v1/models/tts')
    return Response.json({ data: [
      { id: 'gemini/gemini-3.1-flash-tts-preview' },
      { id: 'openrouter/openai/tts-1' },
      { id: 'gemini/gemini-3.8-flash-tts' }
    ] })
  })
  try {
    const voices = await listVoices()
    assert.equal(voices[0].id, 'gemini/gemini-3.8-flash-tts/en-us-arlo')
    assert.equal(voices[0].name, 'Arlo')
    assert.equal(voices[0].group, 'Gemini 3.8 Flash TTS')
    assert.ok(voices.some(v => v.id === 'gemini/gemini-3.8-flash-tts/Kore'))
    assert.ok(voices.some(v => v.id === 'gemini/gemini-3.1-flash-tts-preview/Charon'))
    assert.ok(!voices.some(v => v.id === 'gemini/gemini-3.1-flash-tts-preview/en-us-arlo'))
    assert.equal(voices.filter(v => v.id.startsWith('gemini/gemini-3.8-flash-tts/')).length, 60)
    for (const id of ['gemini/gemini-3.8-flash-tts','gemini/gemini-3.1-flash-tts-preview','openrouter/openai/tts-1']) {
      assert.ok(voices.some(v => v.id === id), `preserve ${id}`)
    }
    assert.equal(new Set(voices.map(v => v.id)).size, voices.length)
  } finally { fetch.mock.restore() }
})

test('Flux requests preserve exact project ratios; other models keep supported preset sizes', async () => {
  const requests = []
  const fetch = mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://router.test/v1/images/generations')
    requests.push(JSON.parse(options.body))
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
  })
  try {
    const flux = 'cf/@cf/black-forest-labs/flux-2-klein-9b'
    await generateImage('beach', flux, '1792x1024')
    await generateImage('lighthouse', flux, '1024x1792')
    await generateImage('beach', 'dall-e-3', '1792x1024')
    await generateImage('square reference', flux, '1024x1024')
    assert.deepEqual(requests.map(r => r.size), ['1792x1008', '1008x1792', '1792x1024', '1024x1024'])
    for (const [i, ratio] of [[0, 16 / 9], [1, 9 / 16]]) {
      const [width, height] = requests[i].size.split('x').map(Number)
      assert.equal(width / height, ratio)
    }
  } finally { fetch.mock.restore() }
})


test('Flux reference pixels are resized without cropping, kept in order, and validated before charging', async () => {
  const { execFileSync } = await import('node:child_process')
  const ffmpeg = (await import('ffmpeg-static')).default
  const { supportsNineRouterImageReferences } = await import('../../src/shared/models.ts')
  const flux = 'cf/@cf/black-forest-labs/flux-2-klein-9b'
  assert.equal(supportsNineRouterImageReferences(flux), true)
  const sheet = execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','color=c=red:s=1024x512','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'])
  let calls = 0
  const fetch = mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    const request = JSON.parse(options.body)
    assert.equal(request.images.length, 2)
    for (const url of request.images) {
      const bytes = Buffer.from(url.split(',')[1], 'base64')
      assert.equal(bytes.readUInt32BE(16), 496)
      assert.equal(bytes.readUInt32BE(20), 248)
    }
    return new Response(sheet, {headers:{'Content-Type':'image/png'}})
  })
  const image = 'data:image/png;base64,' + sheet.toString('base64')
  try {
    await generateImage('same character', flux, '1792x1024', undefined, [image, image])
    await assert.rejects(generateImage('too many', flux, '1792x1024', undefined, Array(5).fill(image)), /4/)
    await assert.rejects(generateImage('invalid', flux, '1792x1024', undefined, ['bad-data']), /referensi/i)
    assert.equal(calls, 1)
  } finally { fetch.mock.restore() }
})


test('TTS forwards narration and language unchanged through 9Router', async () => {
  const text = 'Elin waited.\n<long pause>\nJonas checked the gauge.'
  const audio = Buffer.from('RIFFtestaudio')
  const fetch = mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://router.test/v1/audio/speech')
    assert.deepEqual(JSON.parse(options.body), { model: 'gemini/gemini-3.8-flash-tts/en-us-arlo', input: text, language: 'en-US' })
    return new Response(audio, {headers: {'Content-Type':'audio/wav'}})
  })
  try {
    assert.deepEqual(await speak(text, 'gemini/gemini-3.8-flash-tts/en-us-arlo', 'en-US'), audio)
  } finally { fetch.mock.restore() }
})
