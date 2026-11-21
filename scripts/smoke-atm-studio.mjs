import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import ffmpeg from 'ffmpeg-static'

const root = process.cwd(), temp = mkdtempSync(join(tmpdir(), 'bang-story-atm-smoke-'))
const files = join(temp, 'agent-files'), data = join(temp, 'data')
mkdirSync(files); mkdirSync(data)
execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=0x203348:s=1280x720','-frames:v','1',join(files,'art.png')])
execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=220:duration=15','-ar','24000',join(files,'voice.wav')])
const art = readFileSync(join(files, 'art.png')).toString('base64'), voice = readFileSync(join(files, 'voice.wav'))
const calls = []
const imageRequests = []
let failOutline = false
const instructions = 'TIDE_SWITCH_RULE. Use second-person narration, track resources, seed a mechanical payoff and resolve a real moral choice. Use an original ferry terminal and original protagonist. '
const outline = { premise: 'A ferry terminal floods slowly.', protagonist: 'A dock mechanic with a yellow jacket and square glasses.', resourceLedger: 'One battery and eighteen tides; spend it once.', beats: Array.from({length: 5}, (_,i) => ({ day: 'Day ' + (i * 4 + 1), event: 'Tide rises through a marked drain ' + i, choice: 'Conserve the battery ' + i, cost: 'Lose access to one storage room ' + i, payoff: 'A tide calendar reveals a safe window ' + i })), endingPayoff: 'The seeded tide calendar enables a costly evacuation.', innovation: 'Tide calendar controls access, rather than fighting.' }
const mock = createServer(async (req,res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.url === '/v1/models') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: [{ id: 'atm-smoke-model' }] })); return }
  if (req.url === '/v1/images/generations') { imageRequests.push(JSON.parse(body)); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data:[{ b64_json: art }] })); return }
  if (req.url === '/v1/audio/speech') { res.setHeader('Content-Type','audio/wav'); res.end(voice); return }
  const input = JSON.parse(body || '{}'), name = input.response_format?.json_schema?.name
  calls.push({ name, model:input.model, messages: input.messages })
  let output
  if (name === 'atm_skill') output = { name:'Evidence-based survival', analysis:'Metadata observations are provisional. No transcript was supplied, so actual events and retention cannot be inferred. '.repeat(2), instructions }
  if (name === 'atm_outline') {
    if (failOutline) { res.writeHead(503,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'intentional provider interruption'}})); return }
    output = outline
  }
  if (name === 'script') {
    const n = Number(/Write exactly (\d+) scenes/.exec(input.messages[1].content)?.[1] || 3)
    output = { title:'18 Days Trapped in a Flooding Ferry Terminal', scenes: Array.from({length:n},(_,i)=>({ title:'Day ' + (i+1), story:'You study the tide marker before risking the only battery.', narration:'You mark the tide against the wall, knowing one wasted charge could leave everyone below the water.' })) }
  }
  if (name === 'atm_package') output = { titleOptions:[{title:'18 Days Trapped in a Flooding Ferry Terminal',angle:'Constrained setting and time'},{title:'The Ferry Never Came. You Have One Battery.',angle:'Resource dilemma'},{title:'Zombie Outbreak: Survive 18 Rising Tides',angle:'Time and escalating water'}], description:'An original fictional survival story. Would you spend your last battery charge?', thumbnailPrompt:'Original stick figure dock mechanic in a yellow jacket at a flooding ferry terminal. Before/after divided composition with an original tide gauge and a rising water dilemma. No text or logos.', beforeLabel:'DAY 1', afterLabel:'DAY 18' }
  if (name === 'visuals') {
    const matches = [...input.messages[1].content.matchAll(/^Scene (\d+):/gm)].map((m)=>Number(m[1]))
    output = { world:'A fictional present-day coastal ferry terminal.', characters:[], scenes:matches.map((scene)=>({ scene, setting:'Present-day coastal ferry terminal with tide markings.', action:'A human mechanic checks a wall mark.', wardrobe:[], framing:'Medium shot', avoid:'source channel protagonist, source logo', characters:[], camera:'zoomin', strength:'halus', motion:'Slow push toward the water.', transition:'cut' })) }
  }
  if (name === 'story_sound_design') {
    const scenes=JSON.parse(input.messages[1].content).scenes
    output={cues:[{clipId:scenes[0].id,label:'Pulse tegang',assetId:null,preset:'pulse',startMs:0,durationMs:Math.min(500,scenes[0].durationMs),gainDb:-20,fadeInMs:10,fadeOutMs:50,bed:true}],warnings:[]}
  }
  if (!output) { res.writeHead(400); res.end('Unhandled mock request'); return }
  res.setHeader('Content-Type','application/json')
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}))
})
await new Promise((resolve)=>mock.listen(0,'127.0.0.1',resolve))
const mockBase = 'http://127.0.0.1:' + mock.address().port + '/v1'
const probe = createServer()
await new Promise((resolve)=>probe.listen(0,'127.0.0.1',resolve))
const port = probe.address().port
await new Promise((resolve)=>probe.close(resolve))
const password = randomBytes(18).toString('hex'), salt = randomBytes(16), token = randomBytes(40).toString('hex')
const publicOrigin = 'https://story.yahya.web.id'
const env = { ...process.env, HOST:'127.0.0.1', PORT:String(port), DATA_DIR:data, STUDIO_USER_DATA:data, BANG_STORY_EXPORT_DIR:join(temp,'exports'), BANG_STORY_AGENT_FILES_DIR:files, BANG_STORY_PUBLIC_ORIGIN:publicOrigin, AUTH_USERNAME:'atm-smoke', AUTH_PASSWORD_HASH:'scrypt:' + salt.toString('hex') + ':' + scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex'), SESSION_SECRET:randomBytes(40).toString('hex'), MCP_TOKEN:token }
const base = 'http://127.0.0.1:' + port
let child, client, cookie, logs = ''
async function start() {
  child = spawn(process.execPath,['out/server.cjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',(b)=>{logs=(logs+b.toString()).slice(-6000)})
  child.stderr.on('data',(b)=>{logs=(logs+b.toString()).slice(-6000)})
  for(let i=0;i<80;i++) {
    if(child.exitCode!==null) throw new Error('Server exited: '+logs)
    try { if((await fetch(base+'/api/auth/status')).ok) break } catch {}
    await new Promise((r)=>setTimeout(r,150))
  }
  client=new Client({name:'atm-smoke',version:'1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}))
}
async function stop() {
  await client?.close().catch(()=>{})
  if(child?.exitCode===null) { child.kill('SIGTERM'); await new Promise((r)=>child.once('exit',r)) }
}
async function tool(name,args={},error=false) {
  const out=await client.callTool({name,arguments:args})
  if(error) return out
  assert.notEqual(out.isError,true,name+': '+out.content?.map((c)=>c.text).join('\n'))
  return out.structuredContent?.result
}
async function task(args) {
  const started=await tool('atm.task.start',{...args,approved:true})
  let current=started
  for(let i=0;current.status==='running' && i<800;i++) { await new Promise((r)=>setTimeout(r,150)); current=await tool('atm.task.get',{taskId:started.id}) }
  assert.equal(current.status,'done',current.error||current.message)
  return current
}
try {
  await start()
  await tool('settings.set_custom_endpoint',{baseUrl:mockBase,apiKey:'synthetic-atm-test-key'})
  await tool('settings.set_ninerouter',{baseUrl:mockBase,apiKey:'synthetic-atm-test-key'})
  await tool('settings.update',{patch:{llmProvider:'custom',llmModels:{custom:'atm-smoke-model'},imageProvider:'9router',nineRouterImageModel:'atm-smoke-image',nineRouterTtsModel:'atm-smoke-voice',whisperAuto:false}})
  const w=await tool('atm.workspace.save',{name:'ATM integration smoke',channelUrl:'https://youtube.com/@NobodyGetsIn',language:'en'})
  const other=await tool('atm.workspace.save',{name:'Other workspace'})
  const ref=await tool('atm.reference.save',{workspaceId:w.id,title:'Observed reference',url:'https://youtube.com/watch?v=oXj7bWgRX_I',description:'Only public metadata; transcript not obtained.'})
  assert.equal(ref.transcriptStatus,'missing')
  const foreign=await tool('atm.reference.save',{workspaceId:other.id,title:'Foreign source'})
  const analysis=await task({workspaceId:w.id,kind:'analyze-workspace',idempotencyKey:'skill-one',llmProvider:'custom',llmModel:'atm-override-model'})
  assert.equal(analysis.result.evidence,'metadata')
  const skill=analysis.result
  assert.ok(calls.find((c)=>c.name==='atm_skill').messages[0].content.includes('hypotheses'))
  assert.equal(calls.find((c)=>c.name==='atm_skill').model,'atm-override-model')
  assert.equal((await tool('settings.get')).llmModels.custom,'atm-smoke-model')
  await tool('atm.skill.activate',{workspaceId:w.id,skillId:skill.id})
  const input={workspaceId:w.id,synopsis:'Survive eighteen tides in a flooding ferry terminal with one battery.',durationSec:60,idempotencyKey:'episode-one'}
  let production=await tool('atm.production.create',input)
  const projectId=production.production.projectId
  // Nine scenes exercise the bounded multi-pass export rather than only the short-project path.
  await tool('project.update',{projectId,project:{sceneCount:9,sceneSec:3}})
  assert.equal((await tool('atm.production.create',input)).production.projectId,projectId)
  assert.equal((await tool('atm.production.create',{...input,synopsis:'An entirely different survival brief'},true)).isError,true)
  assert.equal((await tool('atm.skill.save',{workspaceId:w.id,name:'Bad source',instructions,sourceIds:[foreign.id]},true)).isError,true)
  const next=await tool('atm.skill.save',{workspaceId:w.id,name:'Version two',instructions:instructions+'Changed voice.',sourceIds:[ref.id]})
  await tool('atm.skill.activate',{workspaceId:w.id,skillId:next.id})
  assert.equal((await tool('atm.production.get',{projectId})).production.skillSnapshot.version,1)
  const resource=await client.readResource({uri:'bang-story://atm/skills/'+w.id+'/'+skill.id})
  assert.ok(resource.contents[0].text.includes('TIDE_SWITCH_RULE'))
  const planned=await tool('atm.production.save_outline',{projectId,outline})
  assert.equal(planned.production.outline.innovation,outline.innovation)
  const prep=await task({workspaceId:w.id,projectId,kind:'prepare-production',idempotencyKey:'prepare-one'})
  assert.ok(prep.result.summary.sceneCount>0)
  assert.ok(calls.find((c)=>c.name==='script').messages[0].content.includes('TIDE_SWITCH_RULE'))
  assert.ok(calls.find((c)=>c.name==='script').messages[1].content.includes('Tide calendar'))
  const count=calls.length
  assert.equal((await tool('atm.task.start',{workspaceId:w.id,projectId,kind:'prepare-production',idempotencyKey:'prepare-one',approved:true})).id,prep.id)
  await tool('atm.task.get',{taskId:prep.id})
  assert.equal(calls.length,count,'polls and duplicate starts must not repeat LLM work')
  assert.equal((await tool('atm.package.update',{projectId,patch:{referenceIds:[foreign.id]}},true)).isError,true)
  await tool('atm.reference.upload_image',{workspaceId:w.id,referenceId:ref.id,relativePath:'art.png'})
  const pack=prep.result.production.package
  const authored=await tool('atm.package.save',{projectId,package:{titleOptions:pack.titleOptions,selectedTitle:pack.selectedTitle,description:pack.description,thumbnailPrompt:pack.thumbnailPrompt,beforeLabel:pack.beforeLabel,afterLabel:pack.afterLabel,referenceIds:[ref.id]}})
  assert.equal(authored.production.package.referenceIds[0],ref.id)
  assert.equal((await tool('atm.production.save_outline',{projectId,outline},true)).isError,true,'outline cannot silently replace an existing script')
  const routedThumb = await task({workspaceId:w.id,projectId,kind:'generate-thumbnail',thumbnailProvider:'9router',model:'cx/smoke-image',idempotencyKey:'routed-thumbnail-one'})
  assert.ok(routedThumb.result.thumbnailUrl)
  assert.equal(imageRequests[0].images[0],'data:image/png;base64,'+art,'The gateway must receive actual reference bytes, not prose URLs')
  const routedBundle=await tool('project.get',{projectId})
  assert.equal(routedBundle.assets.find(a=>a.id===routedThumb.result.production.package.artworkAssetId).provider,'9router')
  production=await tool('atm.thumbnail.import_artwork',{projectId,relativePath:'art.png'})
  assert.ok(production.thumbnailUrl)
  const image=await fetch(base+production.thumbnailUrl,{headers:{Authorization:'Bearer '+token}})
  assert.equal(image.status,200)
  writeFileSync(join(temp,'thumbnail.jpg'),Buffer.from(await image.arrayBuffer()))
  const info=spawnSync(ffmpeg,['-hide_banner','-i',join(temp,'thumbnail.jpg')],{encoding:'utf8'})
  assert.match(info.stderr,/1280x720/)
  const ws=(await tool('atm.workspace.list')).find((w)=>w.name==='ATM integration smoke')
  const bundle=await tool('atm.workspace.get',{workspaceId:ws.id})
  assert.equal(bundle.productions[0].projectId, projectId)
  assert.ok(!JSON.stringify(bundle).includes('data:image'),'MCP must not return inline image payloads')
  await tool('project.update',{projectId,project:{ttsProvider:'9router',ttsVoice:'atm-smoke-voice'}})
  const run=await task({workspaceId:ws.id,projectId,kind:'produce-video',idempotencyKey:'produce-one'})
  assert.equal(run.result.summary.status,'exported')
  assert.equal(run.result.summary.exportStale,false)
  assert.equal(run.result.summary.imagesReady,run.result.summary.sceneCount)
  assert.equal(run.result.summary.voicesReady,run.result.summary.sceneCount)
  const link=await tool('export.download',{projectId})
  assert.ok(link)
  const bundleProject=await tool('project.get',{projectId})
  assert.ok(calls.some(c=>c.name==='story_sound_design'),'ATM must plan SFX after narration')
  assert.ok(bundleProject.project.editor.soundDesign.cues.some(c=>c.preset==='pulse'))
  assert.ok(bundleProject.assets.some(a=>a.kind==='audio-mix'),'ATM export must use shared mix')
  await tool('clip.update',{projectId,clipId:bundleProject.clips[0].id,patch:{narration:'You choose a different route and the tide destroys the only radio.'}})
  assert.equal((await tool('atm.production.get',{projectId})).summary.packageStale,true)
  assert.equal((await tool('atm.production.get',{projectId})).summary.exportStale,true)
  const duplicate=await tool('project.duplicate',{projectId})
  assert.equal((await tool('atm.production.get',{projectId:duplicate.id})).production.skillSnapshot.version,1)
  assert.equal((await tool('atm.production.get',{projectId:duplicate.id})).production.package,null)
  const active=await tool('atm.production.create',{workspaceId:ws.id,synopsis:'Another original river station survival story.',durationSec:60,idempotencyKey:'failure-episode'})
  failOutline=true
  const failed=await tool('atm.task.start',{workspaceId:ws.id,projectId:active.production.projectId,kind:'prepare-production',idempotencyKey:'fail-once',approved:true})
  await new Promise((r)=>setTimeout(r,250))
  assert.equal((await tool('atm.task.get',{taskId:failed.id})).status,'failed')
  const before=calls.length
  await stop(); await start()
  assert.equal((await tool('atm.production.get',{projectId})).production.skillSnapshot.version,1)
  assert.equal((await tool('atm.task.get',{taskId:failed.id})).status,'failed')
  assert.equal(calls.length,before,'restart must not repeat failed provider work')
  const auth=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:publicOrigin},body:JSON.stringify({username:'atm-smoke',password,remember:false})})
  assert.equal(auth.status,200); cookie=auth.headers.get('set-cookie').split(';')[0]
  if(process.env.ATM_BROWSER_MODULE) {
    const {chromium}=await import(process.env.ATM_BROWSER_MODULE)
    const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.ATM_BROWSER_EXECUTABLE ? {executablePath:process.env.ATM_BROWSER_EXECUTABLE} : {})})
    const context=await browser.newContext({viewport:{width:1440,height:1000}})
    await context.addCookies([{name:'bang_story_session',value:cookie.split('=')[1],domain:'story.yahya.web.id',path:'/',secure:true,httpOnly:true}])
    await context.route(publicOrigin+'/**',async(route)=>{
      const url=new URL(route.request().url())
      if(url.pathname==='/api/events') { await route.fulfill({status:200,contentType:'text/event-stream',body:': smoke heartbeat\n\n'}); return }
      const response=await route.fetch({url:base+url.pathname+url.search,headers:{...route.request().headers(),Cookie:cookie}})
      await route.fulfill({response})
    })
    const page=await context.newPage(), errors=[]
    page.on('pageerror',(e)=>errors.push(e.message))
    await page.goto(publicOrigin,{waitUntil:'domcontentloaded'})
    await page.getByRole('button',{name:'ATM Studio',exact:true}).click()
    await page.getByText('ATM integration smoke',{exact:true}).first().click()
    await page.getByRole('button',{name:/2. Skill cerita/}).click()
    await page.getByText('Versi aktif',{exact:true}).waitFor()
    await page.getByRole('button',{name:/3. Produksi/}).click()
    await page.getByText('18 Days Trapped in a Flooding Ferry Terminal',{exact:true}).first().click()
    await page.getByText('Thumbnail dengan gambar referensi',{exact:true}).waitFor()
    assert.deepEqual(errors,[])
    const dir=process.env.ATM_SCREENSHOT_DIR||temp;mkdirSync(dir,{recursive:true})
    await page.getByText('Thumbnail dengan gambar referensi',{exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:join(dir,'atm-production.png')})
    await page.getByAltText('Thumbnail final video').scrollIntoViewIfNeeded()
    await page.screenshot({path:join(dir,'atm-thumbnail.png')})
    await page.setViewportSize({width:390,height:844})
    await page.getByText('Thumbnail dengan gambar referensi',{exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:join(dir,'atm-mobile.png')})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile layout must not overflow')
    await context.unrouteAll({behavior:'ignoreErrors'})
    await browser.close()
  }
  console.log('ATM smoke passed: grounded skill, immutable snapshots, source ownership, idempotency, outline -> script -> package, reference upload, 1280x720 thumbnail, media -> narration -> MP4, stale package detection, duplication, provider failure, persistence, no charged retry on restart'+(process.env.ATM_BROWSER_MODULE?', desktop/mobile browser flow':'')+'.')
} finally {
  await stop()
  await new Promise((resolve)=>mock.close(resolve))
  rmSync(temp,{recursive:true,force:true})
}
