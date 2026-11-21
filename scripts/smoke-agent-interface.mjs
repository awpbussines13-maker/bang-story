import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import ffmpegStatic from 'ffmpeg-static'

const root = process.cwd()
const serverFile = join(root, 'out', 'server.cjs')
if (!existsSync(serverFile)) throw new Error('Run `npm run build:web` before this smoke check.')
if (!ffmpegStatic) throw new Error('ffmpeg-static is unavailable.')

const tempRoot = mkdtempSync(join(tmpdir(), 'bang-story-agent-smoke-'))
const dataDir = join(tempRoot, 'data')
const workspace = join(tempRoot, 'agent-files')
mkdirSync(dataDir)
mkdirSync(workspace)
const guardFile = join(dataDir, 'keep-on-invalid-delete')
writeFileSync(guardFile, 'temporary smoke data')
assert.ok(resolve(dataDir).startsWith(`${resolve(tempRoot)}${sep}`), 'smoke data must stay in its temporary directory')

const username = 'agent-smoke'
const password = randomBytes(24).toString('base64url')
const salt = randomBytes(16)
const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const token = randomBytes(48).toString('base64url')
const publicOrigin = 'https://story.yahya.web.id'
const env = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: '',
  DATA_DIR: dataDir,
  STUDIO_USER_DATA: dataDir,
  BANG_STORY_EXPORT_DIR: join(tempRoot, 'exports'),
  BANG_STORY_AGENT_FILES_DIR: workspace,
  BANG_STORY_PUBLIC_ORIGIN: publicOrigin,
  AUTH_USERNAME: username,
  AUTH_PASSWORD_HASH: `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`,
  SESSION_SECRET: randomBytes(48).toString('base64url'),
  MCP_TOKEN: token
}

const portProbe = createServer()
await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject))
const port = portProbe.address().port
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()))
env.PORT = String(port)

let output = ''
let child
let client
let projectId
const baseUrl = `http://127.0.0.1:${port}`
const rememberCookie = (value) => value?.split(';', 1)[0]
const cookieHeader = (value) => ({ Cookie: value })
const jsonHeaders = { 'Content-Type': 'application/json', Origin: publicOrigin }

async function startServer() {
  child = spawn(process.execPath, [serverFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4000) })
  child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4000) })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup:\n${output}`)
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Server did not start:\n${output}`)
}

async function stopServer() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function tool(name, args = {}, allowError = false) {
  const result = await client.callTool({ name, arguments: args })
  if (allowError) return result
  assert.notEqual(result.isError, true, `${name} failed: ${result.content?.map((part) => part.text).join('\n')}`)
  return result.structuredContent?.result
}

try {
  assert.equal(env.STUDIO_USER_DATA, dataDir, 'smoke user data must stay in its temporary directory')
  assert.equal(env.BANG_STORY_EXPORT_DIR, join(tempRoot, 'exports'), 'smoke exports must stay in its temporary directory')
  await startServer()

  const anonymousRoutes = [
    ['/api/rpc', { method: 'POST', headers: jsonHeaders, body: '{}' }],
    ['/api/upload?projectId=missing&kind=music', { method: 'POST' }],
    ['/api/events', {}],
    ['/api/asset/missing/file.png', {}],
    ['/api/fonts/missing.ttf', {}],
    ['/api/export-flow?projectId=missing', {}],
    ['/api/download-project?projectId=missing', {}],
    ['/api/rpc', { method: 'OPTIONS' }],
    ['/mcp', { method: 'POST', headers: jsonHeaders, body: '{}' }]
  ]
  for (const [route, init] of anonymousRoutes) assert.equal((await fetch(`${baseUrl}${route}`, init)).status, 401, `${route} must reject anonymous requests`)

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ username, password, remember: true })
  })
  assert.equal(login.status, 200)
  const persistentSetCookie = login.headers.get('set-cookie') ?? ''
  assert.match(persistentSetCookie, /Max-Age=2592000/)
  assert.match(persistentSetCookie, /HttpOnly/)
  assert.match(persistentSetCookie, /Secure/)
  assert.match(persistentSetCookie, /SameSite=Lax/)
  const persistentCookie = rememberCookie(persistentSetCookie)
  assert.ok(persistentCookie)
  const rememberedStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: cookieHeader(persistentCookie) })
  assert.equal((await rememberedStatus.json()).authenticated, true)

  const sessionLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ username, password, remember: false })
  })
  const sessionSetCookie = sessionLogin.headers.get('set-cookie') ?? ''
  assert.equal(sessionLogin.status, 200)
  assert.doesNotMatch(sessionSetCookie, /Max-Age=/)
  const sessionCookie = rememberCookie(sessionSetCookie)

  const forbiddenLogout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: persistentCookie, Origin: 'https://attacker.invalid' }
  })
  assert.equal(forbiddenLogout.status, 403)

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  client = new Client({ name: 'bang-story-smoke', version: '1.0.0' })
  await client.connect(transport)

  const toolList = await client.listTools()
  const toolNames = toolList.tools.map((item) => item.name)
  assert.ok(toolNames.length >= 60)
  assert.ok(toolNames.includes('project.create'))
  assert.ok(toolNames.includes('story.generate_script'))
  assert.ok(toolNames.includes('asset.upload'))
  assert.ok(toolNames.includes('export.start'))
  assert.ok(toolNames.includes('sound.plan') && toolNames.includes('audio.prepare') && toolNames.includes('sound.asset_info'))
  assert.ok(!toolNames.includes('dispatch'))
  assert.ok(!toolNames.includes('settings.revealKey'))
  const scriptSchema = toolList.tools.find((item) => item.name === 'story.generate_script')?.inputSchema
  assert.ok(scriptSchema?.properties?.projectId && scriptSchema.properties?.idempotencyKey && scriptSchema.properties?.approved)
  assert.ok(scriptSchema.required?.includes('approved'))
  const uploadSchema = toolList.tools.find((item) => item.name === 'asset.upload')?.inputSchema
  assert.match(uploadSchema?.properties?.clipId?.description ?? '', /required for kind image or audio/i)

  const resources = await client.listResources()
  const resourceUris = resources.resources.map((item) => item.uri)
  assert.ok(resourceUris.includes('bang-story://capabilities'))
  assert.ok(resourceUris.includes('bang-story://workflows/provider-setup'))
  assert.ok(resourceUris.includes('bang-story://workflows/create-video'))

  const traversalDelete = await tool('project.delete', { projectId: '..', confirm: true }, true)
  assert.equal(traversalDelete.isError, true)
  assert.equal(existsSync(guardFile), true)

  const created = await tool('project.create', {
    synopsis: 'Temporary isolated agent smoke project',
    durationSec: 2,
    sceneCount: 1,
    sceneSec: 2,
    imageProvider: '9router'
  })
  projectId = created.project.id
  assert.match(projectId, /^[0-9a-f-]{36}$/i)
  assert.equal(created.project.imageProvider, '9router')

  await tool('project.update', { projectId, project: { imageProvider: null } })
  assert.equal((await tool('project.get', { projectId })).project.imageProvider ?? null, null)
  await tool('project.update', { projectId, project: { imageProvider: 'higgsfield' } })

  const changed = await tool('clip.create', {
    projectId,
    patch: { title: 'Smoke scene', durationMs: 2000, visualSource: 'persisted storyboard source' }
  })
  const clipId = changed.clips[0].id
  assert.equal((await tool('project.get', { projectId })).clips[0].visualSource, 'persisted storyboard source')
  const missingUploadClip = await tool('asset.upload', { projectId, kind: 'image', relativePath: 'smoke.png' }, true)
  assert.equal(missingUploadClip.isError, true)
  assert.match(missingUploadClip.content?.[0]?.text ?? '', /clipId/i)

  const imagePath = join(workspace, 'smoke.png')
  execFileSync(ffmpegStatic, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=0.1', '-frames:v', '1', '-y', imagePath])
  const escapedUpload = await tool('asset.upload', { projectId, kind: 'image', relativePath: '../smoke.png', clipId }, true)
  assert.equal(escapedUpload.isError, true)
  const outsidePath = join(tempRoot, 'outside.png')
  writeFileSync(outsidePath, 'outside workspace')
  const absoluteUpload = await tool('asset.upload', { projectId, kind: 'image', relativePath: outsidePath, clipId }, true)
  assert.equal(absoluteUpload.isError, true)
  symlinkSync(outsidePath, join(workspace, 'escape.png'))
  const symlinkUpload = await tool('asset.upload', { projectId, kind: 'image', relativePath: 'escape.png', clipId }, true)
  assert.equal(symlinkUpload.isError, true)
  const asset = await tool('asset.upload', { projectId, kind: 'image', relativePath: 'smoke.png', clipId })
  assert.equal(asset.kind, 'image')
  assert.equal((await tool('project.get', { projectId })).clips[0].imageAssetId, asset.id)

  const cue = { id: 'fixture-impact', clipId, label: 'Door impact', preset: 'impact', assetId: null,
    startMs: 500, durationMs: 700, inMs: 0, gainDb: -12, fadeInMs: 5, fadeOutMs: 40, muted: false, manual: true, bed: false }
  await tool('editor.update', { projectId, editor: { soundDesign: { enabled: true, cues: [cue] }, normalizeAudio: false } })
  const invalidSound = await tool('editor.update', { projectId, editor: { soundDesign: { enabled: true, cues: [{...cue, clipId: 'foreign'}] } } }, true)
  assert.equal(invalidSound.isError,true)
  let mixJob = await tool('audio.prepare',{projectId,idempotencyKey:'smoke-audio-once'})
  assert.equal((await tool('audio.prepare',{projectId,idempotencyKey:'smoke-audio-once'})).id,mixJob.id)
  while (!['done','failed','canceled'].includes(mixJob.status)) mixJob=await tool('jobs.wait',{jobId:mixJob.id,waitMs:30000})
  assert.equal(mixJob.status,'done',mixJob.error)
  const mixBundle=await tool('project.get',{projectId})
  assert.equal(mixBundle.assets.find(a=>a.id===mixJob.resultAssetId).kind,'audio-mix')
  execFileSync(ffmpegStatic,['-v','error','-f','lavfi','-i','sine=f=330:d=1','-y',join(workspace,'effect.wav')])
  const effect=await tool('asset.upload',{projectId,kind:'sfx',relativePath:'effect.wav'})
  assert.equal(effect.kind,'sfx')
  const credited=await tool('sound.asset_info',{projectId,assetId:effect.id,source:'Self-generated fixture',license:'Owned'})
  assert.equal(credited.meta.license,'Owned')

  let job = await tool('export.start', {
    projectId,
    fileName: 'agent-smoke-export',
    resolution: 720,
    fps: 30,
    burnCaptions: false,
    writeSrt: false,
    normalizeAudio: false,
    duckMusic: false
  })
  for (let attempt = 0; attempt < 4 && !['done', 'failed', 'canceled'].includes(job.status); attempt++) {
    job = await tool('jobs.wait', { jobId: job.id, waitMs: 30000 })
  }
  assert.equal(job.status, 'done', `export failed: ${job.error ?? job.status}`)
  const download = await tool('export.download', { projectId })
  assert.equal(download.projectId, projectId)
  const downloaded = await fetch(`${baseUrl}/api/download-project?projectId=${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(downloaded.status, 200)
  const mp4 = Buffer.from(await downloaded.arrayBuffer())
  assert.equal(mp4.subarray(4, 8).toString(), 'ftyp')

  writeFileSync(join(tempRoot,'sfx-preview.mp4'),mp4)
  const encoded=execFileSync(ffmpegStatic,['-v','error','-i',join(tempRoot,'sfx-preview.mp4'),'-ar','48000','-ac','1','-f','f32le','-'])
  let peak=0, early=0, cueEnergy=0
  for(let i=0;i<encoded.length;i+=4) {
    const x=encoded.readFloatLE(i);peak=Math.max(peak,Math.abs(x))
    if(i/4<.45*48000)early+=x*x
    if(i/4>.52*48000&&i/4<.8*48000)cueEnergy+=x*x
  }
  assert.ok(encoded.length/4/48000>=1.99&&encoded.length/4/48000<2.04,'AAC stream duration must match video')
  assert.ok(early<.001&&cueEnergy>1,'Encoded SFX must occur at its scheduled time')
  assert.ok(peak<10**(-1/20),'Encoded AAC must retain headroom')

  if (process.env.SFX_BROWSER_MODULE) {
    await tool('project.update',{projectId,project:{title:'SFX browser fixture',step:4,status:'editing'}})
    let planCalls=0
    const writer=createHttpServer(async(req,res)=>{
      if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'sfx-browser-model'}]}));return}
      let text='';for await(const chunk of req)text+=chunk
      const input=JSON.parse(text);planCalls++
      assert.equal(JSON.parse(input.messages[1].content).outputSchema.type,'object')
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({cues:[{sceneId:clipId,label:'Door impact',preset:'impact',assetId:null,startMs:500,endMs:1200,gainDb:-12,bed:false}],warnings:[]})}}]}))
    })
    await new Promise(r=>writer.listen(0,'127.0.0.1',r))
    await tool('settings.set_custom_endpoint',{baseUrl:'http://127.0.0.1:'+writer.address().port+'/v1',apiKey:'browser-test-key'})
    await tool('settings.update',{patch:{llmProvider:'custom',llmModels:{custom:'sfx-browser-model'}}})
    await tool('editor.update',{projectId,editor:{soundDesign:{enabled:true,cues:[{...cue,manual:false}]}}})
    const {default:puppeteer}=await import(pathToFileURL(resolve(process.env.SFX_BROWSER_MODULE)).href)
    const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']})
    try {
      const page=await browser.newPage(), errors=[]
      await page.setViewport({width:1560,height:1100})
      page.on('pageerror',e=>errors.push(e.message))
      await page.setRequestInterception(true)
      page.on('request', async req => {
        try {
          const url=new URL(req.url())
          if(url.origin!==publicOrigin)return req.continue()
          if(url.pathname==='/api/events')return req.respond({status:200,contentType:'text/event-stream',body:': smoke heartbeat\n\n'})
          const headers={...req.headers(),cookie:persistentCookie,origin:publicOrigin}
          delete headers.host
          const response=await fetch(baseUrl+url.pathname+url.search,{method:req.method(),headers,body:req.postData()})
          const responseHeaders=Object.fromEntries(response.headers)
          delete responseHeaders['content-encoding'];delete responseHeaders['transfer-encoding'];delete responseHeaders['content-length']
          await req.respond({status:response.status,headers:responseHeaders,body:Buffer.from(await response.arrayBuffer())})
        } catch(e) {errors.push(e.message);await req.abort().catch(()=>{})}
      })
      await page.evaluateOnNewDocument(()=>{const NativeAudio=window.Audio;window.__testAudio=[];window.Audio=function(...args){const a=new NativeAudio(...args);window.__testAudio.push(a);return a}})
      await page.goto(publicOrigin,{waitUntil:'domcontentloaded'})
      await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('SFX browser fixture')))
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('SFX browser fixture')).click())
      await page.waitForSelector('nav[aria-label="Panel editor"]')
      await page.evaluate(()=>[...document.querySelectorAll('nav[aria-label="Panel editor"] button')].find(b=>b.textContent.includes('Efek suara')).click())
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Susun otomatis').click())
      await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Menyusun SFX…'))
      await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Susun otomatis'&&!b.disabled),{timeout:20000})
      assert.equal(planCalls,1,'automatic SFX button must call configured writer once')
      const planned=await tool('project.get',{projectId})
      assert.ok(planned.project.editor.soundDesign.planHash)
      assert.equal(planned.project.editor.soundDesign.cues[0].durationMs,700)
      assert.equal(planned.project.editor.soundDesign.cues[0].manual,false)

      await page.click('[aria-label="Door impact"]')
      await page.waitForSelector('input[aria-label="Volume (dB)"]')
      await page.waitForFunction(()=>!document.querySelector('[role="status"]')?.textContent.includes('Menyiapkan audio'))
      await page.click('button[aria-label="Putar"]')
      await page.evaluate(()=>document.activeElement?.blur())
      await page.waitForFunction(()=>window.__testAudio.some(a=>!a.paused&&a.currentTime>.2))
      await page.keyboard.press('Space')
      await page.waitForFunction(()=>window.__testAudio.every(a=>a.paused))
      const paused=await page.evaluate(()=>window.__testAudio.at(-1).currentTime)
      await new Promise(r=>setTimeout(r,150))
      assert.ok(Math.abs((await page.evaluate(()=>window.__testAudio.at(-1).currentTime))-paused)<.04)
      await page.keyboard.press('Space')
      await page.waitForFunction(()=>window.__testAudio.some(a=>!a.paused))
      await page.keyboard.press('r')
      await page.waitForFunction(()=>window.__testAudio.some(a=>!a.paused&&a.currentTime<.5))
      await page.keyboard.press('Space')
      await page.waitForFunction(()=>window.__testAudio.every(a=>a.paused))
      await page.$eval('input[aria-label="Volume (dB)"]',el=>{
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
        setter.call(el,'-20');el.dispatchEvent(new Event('input',{bubbles:true}))
      })
      await page.waitForFunction(()=>document.querySelector('input[aria-label="Volume (dB)"]').value==='-20')
      await page.waitForFunction(()=>window.__testAudio.length>=2,{timeout:15000})
      assert.equal(await page.evaluate(()=>window.__testAudio.filter(a=>!a.paused).length),0)
      const saved=await tool('project.get',{projectId})
      assert.equal(saved.project.editor.soundDesign.cues[0].gainDb,-20)
      const dir=process.env.SFX_SCREENSHOT_DIR||tempRoot;mkdirSync(dir,{recursive:true})
      await page.screenshot({path:join(dir,'sfx-editor.png')})
      assert.deepEqual(errors,[])
      console.log('SFX browser passed: automatic planning with provider aliases, actual editor controls, cached mix playback, pause/resume/restart, edit invalidation and saved volume.')
    } finally {await browser.close();await new Promise(r=>writer.close(r))}
  }

  const revocationPath = join(dataDir, '.revoked-sessions')
  mkdirSync(revocationPath)
  const failedLogout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: persistentCookie, Origin: publicOrigin }
  })
  assert.equal(failedLogout.status, 503)
  assert.equal((await fetch(`${baseUrl}/api/auth/status`, { headers: cookieHeader(persistentCookie) })).status, 200)
  rmSync(revocationPath, { recursive: true, force: true })

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: persistentCookie, Origin: publicOrigin }
  })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/)
  assert.equal((await tool('project.delete', { projectId, confirm: true })).deleted, true)
  projectId = undefined

  await client.close()
  client = undefined
  await stopServer()
  await startServer()
  const afterRestart = await fetch(`${baseUrl}/api/auth/status`, { headers: cookieHeader(persistentCookie) })
  assert.equal((await afterRestart.json()).authenticated, false)
  const retainedSession = await fetch(`${baseUrl}/api/auth/status`, { headers: cookieHeader(sessionCookie) })
  assert.equal((await retainedSession.json()).authenticated, true)

  console.log('Agent interface smoke passed: auth, tool/resource discovery, project edits, upload, export/download, safe deletion, logout revocation.')
} catch (error) {
  console.error(error)
  if (output) console.error(output)
  process.exitCode = 1
} finally {
  if (client) await client.close().catch(() => {})
  await stopServer()
  rmSync(tempRoot, { recursive: true, force: true })
}
