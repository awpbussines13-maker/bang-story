import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
mkdirSync(join(root, 'node_modules/.cache'), { recursive: true })
const temp = mkdtempSync(join(root, 'node_modules/.cache/sound-check-'))
try {
  await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import ffmpeg from 'ffmpeg-static'
import {getDb,closeDb} from './src/main/db/index'
import {createProject,getBundle,replaceScript,patchClip,patchClipText,insertAsset,updateEditorSettings,getJob,duplicateProject,updateAssetMeta} from './src/main/repo'
import {prepareAudioMix,audioInputHash,startAudioMix,startSoundPlan,soundPlanningNeeded,parseGeneratedSoundPlan} from './src/main/soundDesign'
import {splitClip} from './src/main/editing'
import {assetAbsPath} from './src/main/paths'
import {sfxSpans,splitSfxCues,validateSoundDesign,soundPlanKey,soundPlanStale} from './src/shared/soundDesign'
import {setSettings} from './src/main/settings'
;(async()=>{
const project=createProject({synopsis:'A door bursts open. The survivor escapes.'})
assert.equal(project.editor.soundDesign?.enabled,true)
replaceScript(project.id,'Sound fixture',[{durationMs:4000,title:'Threat',story:'The door shakes, then bursts open.',narration:'You hear the door.'},{durationMs:4000,title:'Relief',story:'You escape.',narration:'You get outside.'}])
let bundle=getBundle(project.id)
for(const c of bundle.clips)patchClip(c.id,{durationMs:4000})
bundle=getBundle(project.id)
const [first,second]=bundle.clips
const cue={id:'impact',clipId:first.id,label:'Door impact',assetId:null,preset:'impact',startMs:1000,durationMs:700,inMs:0,gainDb:-9,fadeInMs:5,fadeOutMs:40,muted:false,manual:true,bed:false}
const sound={enabled:true,cues:[cue]}
updateEditorSettings(project.id,{soundDesign:sound,normalizeAudio:false})
const signal=new AbortController().signal
const mix=await prepareAudioMix(project.id,signal)
const file=assetAbsPath(project.id,mix.localPath)
function pcm(path){return execFileSync(ffmpeg,['-v','error','-i',path,'-ar','48000','-ac','1','-f','f32le','-'],{maxBuffer:16*1024*1024})}
function energy(buffer,from,to){let sum=0,n=0;for(let i=Math.round(from*48000);i<Math.round(to*48000);i++){sum+=buffer.readFloatLE(i*4)**2;n++}return Math.sqrt(sum/n)}
const raw=pcm(file)
assert.equal(raw.length,8*48000*4)
assert.equal(energy(raw,0,.95),0)
assert.ok(energy(raw,1.02,1.2)>.01)
assert.equal(energy(raw,1.8,3),0)
for(let i=0;i<raw.length;i+=4)assert.ok(Math.abs(raw.readFloatLE(i))<=.842)
assert.equal((await prepareAudioMix(project.id,signal)).id,mix.id,'identical inputs reuse cached mix')
// Separate tones let us measure bed attenuation without confusing it with narration.
const duckProject=createProject({synopsis:'Ducking fixture'})
replaceScript(duckProject.id,'Ducking',[{durationMs:6000,title:'Voice and bed',story:'A warning.',narration:'A warning.'}])
const duckClip=getBundle(duckProject.id).clips[0]
function tone(name,freq,seconds,volume,kind){
 const localPath=name+'.wav'
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=f='+freq+':d='+seconds,'-af','volume='+volume,'-y',assetAbsPath(duckProject.id,localPath)])
 return insertAsset({projectId:duckProject.id,kind,localPath,durationMs:seconds*1000,meta:{source:'fixture',license:'Owned'}})
}
const spoken=tone('spoken',200,1,2,'audio'), music=tone('music',400,6,.4,'music'), ambience=tone('bed',600,6,.4,'sfx')
patchClip(duckClip.id,{audioAssetId:spoken.id,voiceStartMs:1000,voiceInMs:0,voiceOutMs:1000})
updateEditorSettings(duckProject.id,{normalizeAudio:false,duckMusic:false,musicAssetId:music.id,musicVolumeDb:0,voiceVolumeDb:0,
 soundDesign:{enabled:true,cues:[{...cue,id:'bed',clipId:duckClip.id,preset:null,assetId:ambience.id,startMs:0,durationMs:6000,gainDb:0,fadeInMs:0,fadeOutMs:0,bed:true}]}})
const plain=pcm(assetAbsPath(duckProject.id,(await prepareAudioMix(duckProject.id,signal)).localPath))
updateEditorSettings(duckProject.id,{duckMusic:true})
const ducked=pcm(assetAbsPath(duckProject.id,(await prepareAudioMix(duckProject.id,signal)).localPath))
function amplitude(buffer,frequency,from,to){let re=0,im=0,n=0;for(let i=Math.round(from*48000);i<Math.round(to*48000);i++){const x=buffer.readFloatLE(i*4),phase=2*Math.PI*frequency*i/48000;re+=x*Math.cos(phase);im+=x*Math.sin(phase);n++}return 2*Math.hypot(re,im)/n}
for(const f of [400,600]){
 assert.ok(amplitude(ducked,f,1.4,1.8)<amplitude(plain,f,1.4,1.8)*.5,'music and ambience duck beneath voice')
 assert.ok(amplitude(ducked,f,3.5,3.8)>amplitude(plain,f,3.5,3.8)*.9,'bed recovers after narration')
}
assert.ok(Math.abs(amplitude(ducked,200,1.4,1.8)-amplitude(plain,200,1.4,1.8))<.001,'ducking preserves narration')
for(const preset of ['ambience','pulse','riser','impact','whoosh']){
 updateEditorSettings(duckProject.id,{musicAssetId:null,soundDesign:{enabled:true,cues:[{...cue,id:'preset',clipId:duckClip.id,preset,startMs:2500,durationMs:700}]}})
 const rendered=pcm(assetAbsPath(duckProject.id,(await prepareAudioMix(duckProject.id,signal)).localPath))
 assert.ok(energy(rendered,2.55,2.8)>.0001,preset+' must produce audible signal')
}
const reversed=sfxSpans([second,first],{...bundle.project.editor,soundDesign:sound})
assert.equal(reversed[0].startMs,5000)
const crossing={...cue,startMs:1500,durationMs:1000}
const pieces=splitSfxCues([crossing],first.id,'next',2000,()=> 'part-b')
assert.deepEqual(pieces.map(c=>[c.clipId,c.startMs,c.inMs,c.durationMs]),[[first.id,1500,0,500],['next',0,500,500]])
assert.equal(pieces[1].sourceDurationMs,1000)
for(const bad of [{...cue,gainDb:NaN},{...cue,clipId:'foreign'},{...cue,preset:'bad'},{...cue,assetId:'missing'}])assert.throws(()=>validateSoundDesign({...bundle.project.editor,soundDesign:{enabled:true,cues:[bad]}},bundle.clips,bundle.assets))
updateEditorSettings(project.id,{soundDesign:{enabled:true,cues:[crossing]}})
await splitClip(first.id,2000)
bundle=getBundle(project.id)
assert.equal(bundle.project.editor.soundDesign.cues.length,2)
const duplicate=duplicateProject(project.id), copied=getBundle(duplicate.id)
for(const c of copied.project.editor.soundDesign.cues)assert.ok(copied.clips.some(v=>v.id===c.clipId))
assert.ok(copied.project.editor.soundDesign.cues.every(c=>!bundle.project.editor.soundDesign.cues.some(v=>v.id===c.id)))
const audio=assetAbsPath(project.id,'tone.wav')
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=f=200:d=8','-af','volume=0.7','-y',audio])
const local=insertAsset({projectId:project.id,kind:'sfx',localPath:'tone.wav',durationMs:8000,meta:{source:'self-created fixture',license:'owned'}})
const localCue={...cue,clipId:bundle.clips[0].id,assetId:local.id,preset:null,startMs:0,durationMs:1000}
updateEditorSettings(project.id,{soundDesign:{enabled:true,cues:[localCue]}})
const before=audioInputHash(getBundle(project.id))
const bytes=readFileSync(audio);bytes[100]^=1;writeFileSync(audio,bytes)
assert.notEqual(audioInputHash(getBundle(project.id)),before,'same asset ID with changed bytes invalidates mix')
const job=startAudioMix(project.id,'same-request')
assert.equal(startAudioMix(project.id,'same-request').id,job.id)
async function wait(id){for(let i=0;i<400;i++){const j=getJob(id);if(['done','failed','canceled'].includes(j.status))return j;await new Promise(r=>setTimeout(r,25))}throw Error('Job timeout')}
assert.equal((await wait(job.id)).status,'done')
updateEditorSettings(project.id,{soundDesign:{enabled:true,cues:[{...localCue,gainDb:-20}]}})
assert.throws(()=>startAudioMix(project.id,'same-request'),/input berbeda/)
const canonical={clipId:bundle.clips[1].id,label:'Pulse',assetId:null,preset:'pulse',startMs:0,durationMs:500,gainDb:-20,fadeInMs:10,fadeOutMs:20,bed:true}
const {clipId:aliasClip,durationMs:aliasDuration,fadeInMs:aliasIn,fadeOutMs:aliasOut,...rest}=canonical
const alias={...rest,sceneId:aliasClip,endMs:rest.startMs+aliasDuration}
const parsedAlias=parseGeneratedSoundPlan({cues:[alias]})
assert.equal(parsedAlias.cues[0].clipId,aliasClip);assert.equal(parsedAlias.cues[0].durationMs,500)
assert.equal(parsedAlias.cues[0].fadeInMs,0);assert.equal(parsedAlias.cues[0].fadeOutMs,0)
for(const bad of [null,{},[],{scenes:[]},{cues:null},{cues:[{...alias,sceneId:'other',clipId:aliasClip}]},{cues:[{...alias,endMs:NaN}]},{cues:[{...alias,preset:'thunder'}]},{cues:[{...alias,startMs:-1}]}])assert.throws(()=>parseGeneratedSoundPlan(bad),/Format rencana SFX/)
assert.equal(parseGeneratedSoundPlan({cues:[],warnings:[]}).cues.length,0)
// Test the same configured writer protocol as the application, without paid calls.
let calls=0, release, respond, malformed=false
const gate=new Promise(resolve=>{release=resolve})
const mock=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const input=JSON.parse(body||'{}');calls++;respond=input;await gate;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(malformed ? {scenes:[]} : {cues:[alias],warnings:['Rekaman pintu belum tersedia.']})}}]}))})
await new Promise(r=>mock.listen(0,'127.0.0.1',r))
setSettings({llmProvider:'custom',customBaseUrl:'http://127.0.0.1:'+mock.address().port+'/v1',llmModels:{custom:'fixture-model'}})
try{
 const planned=startSoundPlan(project.id,'plan-once');assert.equal(startSoundPlan(project.id,'plan-once').id,planned.id)
 release();assert.equal((await wait(planned.id)).status,'done')
 assert.equal(calls,1);assert.equal(startSoundPlan(project.id,'plan-once').id,planned.id)
 bundle=getBundle(project.id);assert.ok(bundle.project.editor.soundDesign.cues.some(c=>c.id===localCue.id))
 assert.ok(bundle.project.editor.soundDesign.cues.some(c=>c.preset==='pulse'))
 assert.equal(soundPlanStale(bundle.clips,bundle.project.editor,bundle.assets),false)
 assert.ok(respond.response_format.json_schema.name==='story_sound_design')
 assert.deepEqual(JSON.parse(respond.messages[1].content).outputSchema,respond.response_format.json_schema.schema,'schema must remain visible when gateway ignores response_format')
 const savedSound=JSON.stringify(bundle.project.editor.soundDesign)
 malformed=true
 const rejected=startSoundPlan(project.id,'invalid-reply')
 const failure=await wait(rejected.id)
 assert.equal(failure.status,'failed');assert.match(failure.error,/Format rencana SFX/)
 assert.equal(calls,2,'invalid shape must not silently trigger another paid call')
 assert.equal(JSON.stringify(getBundle(project.id).project.editor.soundDesign),savedSound,'bad model output must preserve saved cues')
 patchClipText(bundle.clips[1].id,{narration:'Changed story'})
 assert.equal(soundPlanningNeeded(project.id),true)
 await assert.rejects(()=>prepareAudioMix(project.id,signal),/Susun ulang SFX/)
}finally{await new Promise(r=>mock.close(r))}
assert.deepEqual(readdirSync(join(process.env.STUDIO_USER_DATA,'tmp')),[],'mix temporary files must be cleaned')
closeDb()
console.log('PASS: ducking/recovery/voice preservation, all five presets, SFX timing, duration/peak, cache, reorder/split/duplicate, validation, source bytes, idempotent jobs, real writer protocol, stale-plan gate, manual preservation, cleanup')
})().catch(e=>{console.error(e);process.exitCode=1})
` }, outfile: join(temp, 'check.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3', 'electron', 'ffmpeg-static'], alias: { '@shared': join(root, 'src/shared') }, logLevel: 'silent' })
  const data = join(temp, 'data'); mkdirSync(data)
  const result = spawnSync(process.execPath, [join(temp, 'check.cjs')], { cwd: root, env: { ...process.env, DATA_DIR: data, STUDIO_USER_DATA: data }, encoding: 'utf8', timeout: 90000 })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(result.status, 0, result.error?.message ?? 'Sound checks failed')
} finally { rmSync(temp, { recursive: true, force: true }) }
