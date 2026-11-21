import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { workspaceInputSchema, referenceInputSchema, skillInputSchema, productionInputSchema, packagePatchSchema, outlineSchema, publishingInputSchema, editorialRevisionSchema } from '../shared/atmSchema'
import { dispatch } from '../main/ipc'
import { getChannelIdentity, publicChannelIdentity, saveChannelIdentity } from '../main/atmIdentity'
import { reviseUnproducedAtmScript } from '../main/atmEditorial'
import { getAtmProduction, getAtmWorkspace, listAtmReferences, listAtmSkills, saveAtmReference } from '../main/atmRepo'
import { resolveAgentFile } from './agentFiles'
import { importAtmArtwork } from '../main/atmThumbnail'
import { getProject, clipsOf } from '../main/repo'
import { estimateCredits } from '../main/generation'
import { getSettings } from '../main/settings'
import { DEFAULT_NINE_ROUTER_IMAGE_MODEL, supportsNineRouterImageReferences } from '../shared/models'

const id = z.string().uuid()
function publicValue(value: any): any {
  if (Array.isArray(value)) return value.map(publicValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key === 'thumbnailUrl' && typeof v === 'string' && v.startsWith('data:') ? '(stored image reference)' : publicValue(v)]))
  return value
}
function result(value: unknown) {
  const clean = publicValue(value ?? null)
  return { content: [{ type: 'text' as const, text: JSON.stringify(clean, null, 2) }], structuredContent: { result: clean } }
}
function workspaceImage(relativePath: string): string {
  const file = resolveAgentFile(relativePath)
  if (statSync(file).size > 6 * 1024 * 1024) throw new Error('Gambar melebihi 6 MB.')
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extname(file).toLowerCase()]
  if (!mime) throw new Error('Gunakan PNG, JPEG, atau WebP.')
  return 'data:' + mime + ';base64,' + readFileSync(file).toString('base64')
}

export function registerAtmTools(server: McpServer): void {
  const tool = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.infer<S>) => unknown) => {
    server.registerTool(name, { description, inputSchema: schema as any }, async (args: any) => {
      try { return result(await run(schema.parse(args))) }
      catch (e) { return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Tugas ATM gagal.' }], isError: true } }
    })
  }
  tool('atm.workspace.list', 'List channel/series workspaces with their active editorial skill.', z.object({}), () => dispatch('atm:list'))
  tool('atm.workspace.save', 'Create or update a channel/series workspace. English is the default content language.', workspaceInputSchema, (input) => dispatch('atm:saveWorkspace', [input]))
  tool('atm.workspace.get', 'Read source evidence, skill versions, production progress and persistent tasks. Missing transcripts are explicit.', z.object({ workspaceId: id }), ({ workspaceId }) => dispatch('atm:get', [workspaceId]))
  tool('atm.identity.get', 'Read the channel-specific recurring cast and sheet hashes without image bytes.', z.object({ workspaceId: id, channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/) }), ({ workspaceId, channelId }) => publicChannelIdentity(getChannelIdentity(workspaceId, channelId)))
  tool('atm.identity.save', 'Capture original channel characters from an owned production, including actual reference bytes. New episodes inherit independent copies; existing episodes retain their snapshot.', z.object({ workspaceId: id, channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/), templateProjectId: id, characterIds: z.array(id).min(1).max(8), symbol: z.string().trim().min(1).max(2000), idempotencyKey: z.string().min(1).max(200), markRelativePath: z.string().min(1).max(500).optional() }), ({ markRelativePath, ...input }) => saveChannelIdentity({ ...input, ...(markRelativePath ? { markDataUrl: workspaceImage(markRelativePath) } : {}) }))
  tool('atm.reference.save', 'Save observed metadata, an actual transcript or a clearly labelled video analysis. Never label guessed events as fetched transcripts. Use upload_image for a local reference image.', referenceInputSchema, (input) => dispatch('atm:saveReference', [input]))
  tool('atm.reference.import', 'Import metadata, thumbnail and publicly available captions for one YouTube video. No AI provider charge. Missing captions remain missing.', z.object({ workspaceId: id, url: z.string().max(500) }), ({ workspaceId, url }) => dispatch('atm:importReference', [workspaceId, url]))
  tool('atm.reference.import_channel', 'Import up to eight public channel videos. Uses the workspace channel URL; YouTube may restrict automatic access.', z.object({ workspaceId: id }), ({ workspaceId }) => dispatch('atm:importChannel', [workspaceId]))
  tool('atm.reference.upload_image', 'Attach an image from the configured agent workspace as a thumbnail reference. Path must stay inside that workspace.', z.object({ workspaceId: id, referenceId: id, relativePath: z.string().min(1).max(500) }), ({ workspaceId, referenceId, relativePath }) => {
    const ref = listAtmReferences(workspaceId).find((r) => r.id === referenceId)
    if (!ref) throw new Error('Referensi bukan milik ruang ATM ini.')
    return saveAtmReference({ ...ref, thumbnailUrl: workspaceImage(relativePath) })
  })
  tool('atm.skill.save', 'Save a new immutable skill version from evidence or an agent analysis. Existing versions and production snapshots are preserved.', skillInputSchema, (input) => dispatch('atm:saveSkill', [input]))
  tool('atm.skill.activate', 'Set the default skill for new productions in the same workspace. Existing productions keep their captured version.', z.object({ workspaceId: id, skillId: id }), ({ workspaceId, skillId }) => dispatch('atm:activateSkill', [workspaceId, skillId]))
  tool('atm.production.create', 'Create a production project with an immutable skill snapshot and an original brief. Reusing idempotencyKey returns the existing project.', productionInputSchema, (input) => dispatch('atm:createProduction', [input]))
  tool('atm.production.get', 'Read captured skill, causal outline, publishing package, artifact URLs and next action for a production.', z.object({ projectId: id }), ({ projectId }) => dispatch('atm:production', [projectId]))
  tool('atm.production.revise_draft', 'Atomically revise a draft outline, every scene and publishing package before any scene media exists. Preserves previous text, skill, cast and references; rejects stale edits and active jobs. Reuse idempotencyKey after reconnect.', editorialRevisionSchema, reviseUnproducedAtmScript)
  tool('atm.production.save_outline', 'Save an agent-authored causal outline before scenes exist, without a provider call. The internal writer will reuse it. Wait for any active writer task to finish or cancel it first.', z.object({ projectId: id, outline: outlineSchema }), ({ projectId, outline }) => dispatch('atm:saveOutline', [projectId, outline]))
  tool('atm.package.save', 'Save a complete agent-authored publishing package against the current script, without another LLM call. Existing thumbnail artwork is cleared; use package.update for small edits that should retain artwork.', z.object({ projectId: id, package: publishingInputSchema }), ({ projectId, package: pack }) => dispatch('atm:savePublishingPackage', [projectId, pack]))
  tool('atm.production.estimate', 'Review scene count and available per-image provider estimate before starting produce-video. Native Gemini thumbnail and LLM/TTS costs are additional and may be unestimated.', z.object({ projectId: id }), async ({ projectId }) => {
    if (!getAtmProduction(projectId)) throw new Error('Project bukan produksi ATM.')
    const p = getProject(projectId), s = getSettings()
    const provider = p.imageProvider || s.imageProvider
    const model = provider === '9router' ? (supportsNineRouterImageReferences(p.imageModel || '') ? p.imageModel! : s.nineRouterImageModel || DEFAULT_NINE_ROUTER_IMAGE_MODEL) : p.imageModel || s.imageModel
    const scenes = clipsOf(projectId)
    const missing = scenes.filter((c) => !c.imageAssetId).length
    const perImage = provider === '9router' ? null : await estimateCredits('image', model, p.aspectRatio)
    return { sceneCount: scenes.length, missingImages: missing, imageProvider: provider, imageModel: model, perImageEstimate: perImage, costKnown: perImage !== null, excludes: ['LLM', 'narration', 'Gemini thumbnail'], message: !scenes.length ? 'Run prepare-production first to obtain a concrete scene count.' : 'Review provider pricing before producing media.' }
  })
  tool('atm.package.update', 'Choose/edit a title, description, art prompt, day labels and up to three owned thumbnail reference IDs. Changing art prompt or references invalidates old artwork; changing labels only invalidates the composite.', z.object({ projectId: id, patch: packagePatchSchema }), ({ projectId, patch }) => dispatch('atm:savePackage', [projectId, patch]))
  tool('atm.thumbnail.import_artwork', 'Import original image artwork made by an external agent from its configured workspace and render editable labels at 1280x720.', z.object({ projectId: id, relativePath: z.string().min(1).max(500) }), ({ projectId, relativePath }) => importAtmArtwork(projectId, workspaceImage(relativePath)))
  tool('atm.thumbnail.render', 'Render changed labels using existing original artwork. Does not call an AI provider.', z.object({ projectId: id }), ({ projectId }) => dispatch('atm:renderThumbnail', [projectId]))
  tool('atm.task.start', 'Start a persistent, idempotent AI task and return immediately. analyze-reference uses Gemini video input; analyze-workspace creates a draft skill; prepare-production creates outline/script/package; produce-video resumes missing storyboard/images/narration/export/thumbnail. Review atm.production.estimate before produce-video. Provider charges may apply; never retry a paid task with a new key just because a connection timed out. Poll atm.task.get.', z.object({
    workspaceId: id, kind: z.enum(['analyze-reference','analyze-workspace','prepare-production','produce-video','generate-package','generate-thumbnail']),
    projectId: id.optional(), referenceId: id.optional(), model: z.string().max(100).optional(), idempotencyKey: z.string().min(1).max(200), approved: z.literal(true),
    thumbnailProvider: z.enum(['gemini','9router']).optional().describe('Thumbnail provider; 9router reference images require a cx/ Codex image model.'),
    llmProvider: z.enum(['gemini','openrouter','groq','custom','9router']).optional().describe('Optional task-scoped LLM override; supply llmModel too. Does not change global settings.'), llmModel: z.string().min(1).max(200).optional()
  }), ({ approved: _approved, ...input }) => dispatch('atm:startTask', [input]))
  tool('atm.task.get', 'Read persistent task status/result. Polling never starts or repeats paid work.', z.object({ taskId: id }), ({ taskId }) => dispatch('atm:task', [taskId]))
  tool('atm.task.cancel', 'Cancel an active task and its owned pending media jobs. Completed stages remain available.', z.object({ taskId: id }), ({ taskId }) => dispatch('atm:cancelTask', [taskId]))

  server.registerResource('ATM production workflow', 'bang-story://workflows/atm', { mimeType: 'text/markdown' }, () => ({
    contents: [{ uri: 'bang-story://workflows/atm', mimeType: 'text/markdown', text: [
      '# ATM: observe, adapt, modify, improve',
      '1. List/create a workspace. Import target videos and thumbnails; add actual transcripts, or start analyze-reference tasks with Gemini video input. Poll task.get and inspect evidence limitations.',
      '2. Start analyze-workspace to create a skill, or save an agent-authored evidence-grounded skill. Read and activate a version. A metadata-only skill is provisional; public views do not prove retention, CTR or virality.',
      '3. Create a production with a genuinely new brief and idempotency key. Skill snapshot is immutable. Start prepare-production; the internal generator uses the same snapshot for causal outline, scene script and packaging. An outer agent can instead save_outline before scenes exist, then author scenes through clip.create and save the finished package with atm.package.save; this avoids requiring a second LLM to rewrite the agent work.',
      '4. Inspect production.get and project.get. Review outline causality, originality, resource accounting, title promise and ending. Update the story before media; regenerate publishing package after script changes.',
      '5. Select thumbnail reference IDs with package.update. Actual image bytes are sent, never only prose URLs. Default thumbnail artwork uses native Gemini. thumbnailProvider=9router with a cx/ image model uses the stored 9Router connection and images[] input; reference-incompatible models are rejected. An external image agent may instead upload original artwork.',
      '6. Review production.estimate and provider charges. Start produce-video to resume missing visuals, still-image scene assets, narration, captions, scene-aware SFX, MP4 export and thumbnail. SFX planning uses the configured writer after narration alignment; manual cues are preserved. Completed assets are reused. Character candidates are compared against actual reference sheets before activation. Existing images undergo whole-project review/repair before export. Use characters.consistency.inspect for current approval or characters.consistency.review with repair=true and a stable idempotencyKey; poll the returned job using jobs.get. Automatic review has a persistent budget of three image attempts per scene/context across jobs and restarts. Stop on pass; otherwise select the best inspected candidate, flag it best-effort for manual inspection, and permit export without more generation. Unavailable or malformed inspection stops without a blind image retry. Set settings.update imageReviewEnabled=false to skip AI review/repair and export with manual inspection. Changed image/reference bytes, cast or scene context invalidate approval. Moving video cannot inherit approval from one still frame. Poll task.get; failure does not silently retry charged work. After restart inspect failed task and project jobs before creating a new attempt.',
      '7. Use export.download for MP4 and production.get for final thumbnail/title/description. Web downloads require session cookie or MCP bearer Authorization. Publishing to YouTube requires a connected authorized uploader; this workflow currently prepares artifacts and does not claim an upload occurred.',
      'Skills can also be read through bang-story://atm/skills/{workspaceId}/{skillId}; the outer agent and internal script generator share the same versioned editorial knowledge.',
      'Optional llmProvider + llmModel on task.start override the writer for that task only. Native video analysis and thumbnail model selection are separate. An explicit new attempt after a provider failure can use another model without changing global settings.'
    ].join('\n\n') }]
  }))
  server.registerResource('ATM skill', new ResourceTemplate('bang-story://atm/skills/{workspaceId}/{skillId}', { list: undefined }), { mimeType: 'text/markdown' }, (uri, variables) => {
    const workspaceId = String(variables.workspaceId), skillId = String(variables.skillId)
    getAtmWorkspace(workspaceId)
    const skill = listAtmSkills(workspaceId).find((s) => s.id === skillId)
    if (!skill) throw new Error('Skill tidak ditemukan di ruang ATM ini.')
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# ' + skill.name + '\n\nVersion ' + skill.version + '\nEvidence: ' + skill.evidence + '\n\n' + skill.instructions + '\n\n## Source analysis\n\n' + skill.analysis }] }
  })
}
