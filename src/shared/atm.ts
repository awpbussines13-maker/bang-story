export interface AtmWorkspace {
  id: string
  name: string
  channelUrl: string
  language: string
  notes: string
  activeSkillId: string | null
  createdAt: number
  updatedAt: number
}

export interface AtmReference {
  id: string
  workspaceId: string
  url: string
  title: string
  thumbnailUrl: string
  description: string
  transcript: string
  videoAnalysis: string
  transcriptStatus: 'missing' | 'provided' | 'fetched'
  notes: string
  viewCount: number | null
  publishedAt: string
  capturedAt: number
}

export interface AtmSkill {
  id: string
  workspaceId: string
  version: number
  name: string
  instructions: string
  analysis: string
  sourceIds: string[]
  evidence: 'metadata' | 'transcripts' | 'video' | 'mixed'
  createdAt: number
}

export interface AtmPackage {
  titleOptions: { title: string; angle: string }[]
  selectedTitle: string
  description: string
  thumbnailPrompt: string
  beforeLabel: string
  afterLabel: string
  referenceIds: string[]
  artworkAssetId: string | null
  thumbnailAssetId: string | null
  scriptHash: string
  generatedAt: number
}

export interface AtmOutline {
  premise: string
  protagonist: string
  resourceLedger: string
  beats: { day: string; event: string; choice: string; cost: string; payoff: string }[]
  endingPayoff: string
  innovation: string
}

export interface IdentitySnapshot {
  markAssetId?: string
  markHash?: string
  id: string
  workspaceId: string
  channelId: string
  version: number
  symbol: string
  characters: { name: string; description: string; hash: string; characterId: string; sheetAssetId: string }[]
}

export interface AtmProduction {
  identitySnapshot: IdentitySnapshot | null
  projectId: string
  workspaceId: string
  skillId: string
  skillSnapshot: AtmSkill
  brief: string
  outline: AtmOutline | null
  package: AtmPackage | null
  createdAt: number
  updatedAt: number
}

export interface AtmProductionSummary {
  exportFingerprint: string | null
  projectId: string
  title: string
  skillVersion: number
  status: string
  sceneCount: number
  imagesReady: number
  voicesReady: number
  thumbnailUrl: string | null
  packageStale: boolean
  exportStale: boolean
}

export interface AtmBundle {
  workspace: AtmWorkspace
  references: AtmReference[]
  skills: AtmSkill[]
  productions: AtmProductionSummary[]
  tasks: AtmTask[]
}

export type AtmTaskKind = 'analyze-reference' | 'analyze-workspace' | 'prepare-production' | 'produce-video' | 'generate-package' | 'generate-thumbnail'
export interface AtmTaskInput {
  workspaceId: string
  kind: AtmTaskKind
  projectId?: string
  referenceId?: string
  model?: string
  thumbnailProvider?: 'gemini' | '9router'
  llmProvider?: import('./types').LlmProvider
  llmModel?: string
  idempotencyKey: string
}
export interface AtmTask {
  id: string
  workspaceId: string
  projectId: string | null
  kind: AtmTaskKind
  status: 'running' | 'done' | 'failed' | 'canceled'
  message: string
  error: string | null
  result: unknown
  createdAt: number
  updatedAt: number
}
export interface AtmProductionDetail {
  production: AtmProduction
  summary: AtmProductionSummary
  artworkUrl: string | null
  thumbnailUrl: string | null
  nextAction: string
}

export type AtmWorkspaceInput = { id?: string; name: string; channelUrl?: string; language?: string; notes?: string }
export type AtmReferenceInput = { id?: string; workspaceId: string; url?: string; title: string; thumbnailUrl?: string; description?: string; transcript?: string; videoAnalysis?: string; transcriptStatus?: AtmReference['transcriptStatus']; notes?: string; viewCount?: number | null; publishedAt?: string }
export type AtmSkillInput = { workspaceId: string; name: string; instructions: string; analysis?: string; sourceIds?: string[] }
export type AtmProductionInput = { workspaceId: string; synopsis: string; durationSec?: number; language?: string; skillId?: string; idempotencyKey: string; channelId?: string }
export type AtmPackagePatch = Partial<Pick<AtmPackage, 'selectedTitle' | 'description' | 'thumbnailPrompt' | 'beforeLabel' | 'afterLabel' | 'referenceIds'>>
export type AtmPublishingInput = Pick<AtmPackage, 'titleOptions' | 'selectedTitle' | 'description' | 'thumbnailPrompt' | 'beforeLabel' | 'afterLabel' | 'referenceIds'>

export interface AtmApi {
  startTask(input: AtmTaskInput): Promise<AtmTask>
  task(taskId: string): Promise<AtmTask>
  cancelTask(taskId: string): Promise<AtmTask>
  list(): Promise<AtmWorkspace[]>
  saveWorkspace(input: AtmWorkspaceInput): Promise<AtmWorkspace>
  get(workspaceId: string): Promise<AtmBundle>
  saveReference(input: AtmReferenceInput): Promise<AtmReference>
  importReference(workspaceId: string, url: string): Promise<AtmReference>
  importChannel(workspaceId: string): Promise<{ imported: number; warnings: string[] }>
  analyzeReference(workspaceId: string, referenceId: string): Promise<AtmReference>
  removeReference(workspaceId: string, referenceId: string): Promise<void>
  analyze(workspaceId: string): Promise<AtmSkill>
  saveSkill(input: AtmSkillInput): Promise<AtmSkill>
  activateSkill(workspaceId: string, skillId: string): Promise<AtmWorkspace>
  createProduction(input: AtmProductionInput): Promise<AtmProductionDetail>
  production(projectId: string): Promise<AtmProductionDetail | null>
  saveOutline(projectId: string, outline: AtmOutline): Promise<AtmProductionDetail>
  savePublishingPackage(projectId: string, pack: AtmPublishingInput): Promise<AtmProductionDetail>
  generatePackage(projectId: string): Promise<AtmProductionDetail>
  savePackage(projectId: string, patch: AtmPackagePatch): Promise<AtmProductionDetail>
  generateThumbnail(projectId: string, model?: string): Promise<AtmProductionDetail>
  importArtwork(projectId: string, imageDataUrl: string): Promise<AtmProductionDetail>
  renderThumbnail(projectId: string): Promise<AtmProductionDetail>
}

export const THUMBNAIL_LAYOUT = {
  width: 1280, height: 720, fontSize: 132, top: 12, left: 28, right: 668,
  labelHeight: 120,
  beforeColor: '#ffffff', afterColor: '#ff633d', backdrop: '#141414'
} as const
