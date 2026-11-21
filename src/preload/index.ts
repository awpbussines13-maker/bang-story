import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENTS, type StudioApi } from '../shared/api'

const call =
  <T>(channel: string) =>
  (...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args)

const listen =
  <T>(channel: string) =>
  (cb: (payload: T) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }

const api: StudioApi = {
  sound: { plan: call('sound:plan'), assetInfo: call('sound:assetInfo') },
  audio: { prepare: call('audio:prepare') },
  consistency: { inspect: call('consistency:inspect'), review: call('consistency:review'), setStyleReference: call('consistency:setStyleReference') },
  atm: {
    startTask: call('atm:startTask'), task: call('atm:task'), cancelTask: call('atm:cancelTask'),
    list: call('atm:list'), saveWorkspace: call('atm:saveWorkspace'), get: call('atm:get'),
    saveReference: call('atm:saveReference'), importReference: call('atm:importReference'), importChannel: call('atm:importChannel'), analyzeReference: call('atm:analyzeReference'), removeReference: call('atm:removeReference'),
    analyze: call('atm:analyze'), saveSkill: call('atm:saveSkill'), activateSkill: call('atm:activateSkill'),
    createProduction: call('atm:createProduction'), production: call('atm:production'),
    saveOutline: call('atm:saveOutline'), savePublishingPackage: call('atm:savePublishingPackage'),
    generatePackage: call('atm:generatePackage'), savePackage: call('atm:savePackage'),
    generateThumbnail: call('atm:generateThumbnail'), importArtwork: call('atm:importArtwork'), renderThumbnail: call('atm:renderThumbnail')
  },
  projects: {
    list: call('projects:list'),
    create: call('projects:create'),
    get: call('projects:get'),
    save: call('projects:save'),
    remove: call('projects:remove'),
    duplicate: call('projects:duplicate')
  },
  story: {
    script: call('story:script'),
    visuals: call('story:visuals'),
    musicPrompt: call('story:musicPrompt')
  },
  generate: {
    clipImage: call('generate:clipImage'),
    clipVideo: call('generate:clipVideo'),
    clipTts: call('generate:clipTts'),
    characterSheet: call('generate:characterSheet'),
    missingImages: call('generate:missingImages'),
    missingVideos: call('generate:missingVideos'),
    missingTts: call('generate:missingTts'),
    narration: call('generate:narration'),
    syncCaptions: call('generate:syncCaptions'),
    cancel: call('generate:cancel'),
    estimate: call('generate:estimate')
  },
  clips: {
    split: call('clips:split'),
    detachVoice: call('clips:detachVoice')
  },
  assets: {
    setActive: call('assets:setActive'),
    setWords: call('assets:setWords'),
    pickMusic: call('assets:pickMusic'),
    pickSfx: call('assets:pickSfx'),
    pickImage: call('assets:pickImage'),
    pickVideo: call('assets:pickVideo')
  },
  settings: {
    get: call('settings:get'),
    set: call('settings:set'),
    keys: call('settings:keys'),
    setKey: call('settings:setKey'),
    setCustom: call('settings:setCustom'),
    setNineRouter: call('settings:setNineRouter'),
    clearKey: call('settings:clearKey'),
    revealKey: call('settings:revealKey'),
    testKey: call('settings:testKey'),
    voices: call('settings:voices')
  },
  models: {
    list: call('models:list')
  },
  flowImages: {
    exportSummary: call('flowImages:exportSummary'),
    exportZip: call('flowImages:exportZip'),
    reference: call('flowImages:reference'),
    importImage: call('flowImages:importImage'),
    importUrl: call('flowImages:importUrl'),
    changeImage: call('flowImages:changeImage'),
    previewZip: call('flowImages:previewZip'),
    applyZip: call('flowImages:applyZip')
  },
  exporter: {
    start: call('export:start'),
    defaultFolder: call('export:defaultFolder'),
    pickFolder: call('export:pickFolder'),
    reveal: call('export:reveal'),
    downloadProject: call('export:downloadProject'),
    flowData: call('export:flowData')
  },
  app: {
    openExternal: call('app:openExternal'),
    copyText: call('app:copyText'),
    version: call('app:version')
  },
  whisper: {
    status: call('whisper:status'),
    download: call('whisper:download'),
    cancel: call('whisper:cancel'),
    remove: call('whisper:remove'),
    openFolder: call('whisper:openFolder')
  },
  on: {
    whisper: listen(EVENTS.whisper),
    job: listen(EVENTS.job),
    clip: listen(EVENTS.clip),
    character: listen(EVENTS.character),
    asset: listen(EVENTS.asset)
  }
}

contextBridge.exposeInMainWorld('api', { ...api, isDesktop: true })
