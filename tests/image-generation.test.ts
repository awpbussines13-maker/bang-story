import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { getDb } from '../src/main/db'
import { generateClipImage, generateMissingImages } from '../src/main/generation'
import { cancelJob } from '../src/main/jobs'
import { applyVisuals, clipsOf, createProject, getAsset, getClip, getJob, insertJob, replaceScript, updateJob } from '../src/main/repo'
import { setSettings } from '../src/main/settings'

const dataDir = mkdtempSync(join(tmpdir(), 'bang-story-image-test-'))
process.env.STUDIO_USER_DATA = dataDir
const requests: { prompt: string; size: string }[] = []
const originalFetch = globalThis.fetch
// Only the external image service is replaced; jobs, prompts, SQLite and files are real.
globalThis.fetch = async (_url, options) => {
  requests.push(JSON.parse(String(options?.body)))
  return Response.json({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }] })
}
setSettings({ imageProvider: '9router', nineRouterBaseUrl: 'http://image-service.invalid/v1' })

function fixture(count = 1) {
  const project = createProject({ styleId: 'anime', aspectRatio: '9:16' })
  replaceScript(project.id, 'Arrival in Cairo', Array.from({ length: count }, () => ({
    title: 'Arrival', story: 'Rian looks out an airplane window at Cairo at dawn.', narration: 'Arrival in Cairo.', durationMs: 5000
  })))
  return { project, clips: clipsOf(project.id) }
}

function plan(clipId: string, projectId: string) {
  applyVisuals(projectId, [{ name: 'Rian', description: 'Human Indonesian man, 22, short black hair. Default outfit: cream shirt.' }], [{
    clipId,
    visualPrompt: 'Setting: Cairo, Egypt, passenger aircraft cabin at dawn.\nAction: Rian sits beside an oval airplane window, looking anxiously at the city.\nAvoid: weapons, combat',
    characterNames: ['Rian'], cameraPreset: 'zoomin', motionStrength: 'halus', videoPrompt: '', transition: 'fade'
  }])
}

test('rejects an empty visual plan before creating an image job', () => {
  const { clips } = fixture()
  assert.throws(() => generateClipImage(clips[0].id), /visual/i)
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM jobs WHERE clip_id = ?').get(clips[0].id)?.['n'], 0)
})

test('rejects a visual plan from an earlier version of the story', () => {
  const { project, clips } = fixture()
  plan(clips[0].id, project.id)
  getDb().prepare('UPDATE clips SET story = ? WHERE id = ?').run('Rian exits Cairo airport with his suitcase.', clips[0].id)
  assert.throws(() => generateClipImage(clips[0].id), /visual/i)
})

test('rejects an avoid-only prompt with no scene to depict', () => {
  const { clips } = fixture()
  getDb().prepare('UPDATE clips SET visual_prompt = ? WHERE id = ?').run('Avoid: weapons, combat', clips[0].id)
  assert.throws(() => generateClipImage(clips[0].id), /visual/i)
})

test('checks the entire image batch before creating any jobs or character sheets', () => {
  const { project, clips } = fixture(2)
  plan(clips[0].id, project.id)
  assert.throws(() => generateMissingImages(project.id), /visual/i)
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM jobs WHERE project_id = ?').get(project.id)?.['n'], 0)
})

test('rechecks the story after waiting for a character sheet', async () => {
  const { project, clips } = fixture()
  plan(clips[0].id, project.id)
  const pending = insertJob({ projectId: project.id, characterId: getClip(clips[0].id).characterIds[0], kind: 'sheet', provider: 'higgsfield' })
  setSettings({ imageProvider: 'higgsfield' })
  const job = generateClipImage(clips[0].id)
  await new Promise((resolve) => setTimeout(resolve, 30))
  getDb().prepare('UPDATE clips SET story = ? WHERE id = ?').run('Rian exits Cairo airport with his suitcase.', clips[0].id)
  updateJob(pending.id, { status: 'done' })
  for (let i = 0; i < 150 && ['queued', 'running'].includes(getJob(job.id)!.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  setSettings({ imageProvider: '9router' })
  assert.equal(getJob(job.id)!.status, 'failed')
  assert.match(getJob(job.id)!.error!, /visual/i)
  assert.equal(getClip(clips[0].id).imageAssetId, null)
})

test('sends the actual scene and character to the image service and attaches its result to that clip', async () => {
  const { project, clips } = fixture()
  plan(clips[0].id, project.id)
  const job = generateClipImage(clips[0].id)
  for (let i = 0; i < 100 && ['queued', 'running'].includes(getJob(job.id)!.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(getJob(job.id)!.status, 'done', getJob(job.id)!.error ?? '')
  const image = getAsset(getClip(clips[0].id).imageAssetId)!
  assert.equal(image.clipId, clips[0].id)
  assert.match(image.prompt!, /Cairo, Egypt, passenger aircraft cabin at dawn/)
  assert.match(image.prompt!, /Human Indonesian man, 22/)
  assert.match(image.prompt!, /Must not appear in the image: weapons, combat/)
  assert.equal(requests.at(-1)!.prompt, image.prompt)
  assert.equal(requests.at(-1)!.size, '1024x1792')
})

test('respects custom 9router image parallel concurrency limit', async () => {
  setSettings({ imageProvider: '9router', nineRouterImageConcurrency: 2 })
  const { project, clips } = fixture(4)
  for (const c of clips) plan(c.id, project.id)
  let inFlight = 0
  let maxConcurrent = 0
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    inFlight++
    if (inFlight > maxConcurrent) maxConcurrent = inFlight
    await new Promise((r) => setTimeout(r, 50))
    inFlight--
    return Response.json({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }] })
  }
  const jobs = generateMissingImages(project.id)
  for (let i = 0; i < 200 && jobs.some((j) => ['queued', 'running'].includes(getJob(j.id)!.status)); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  globalThis.fetch = prevFetch
  assert.equal(maxConcurrent, 2)
  assert.ok(jobs.every((j) => getJob(j.id)!.status === 'done'))
})

after(async () => {
  const active = getDb().prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all() as { id: string }[]
  for (const job of active) await cancelJob(job.id)
  await new Promise((resolve) => setTimeout(resolve, 50))
  globalThis.fetch = originalFetch
  getDb().close()
  rmSync(dataDir, { recursive: true, force: true })
})
