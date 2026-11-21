import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const resources: Record<string, { name: string; description: string; text: string }> = {
  'bang-story://capabilities': {
    name: 'Bang Story capabilities',
    description: 'Daftar kemampuan agent dan aturan pemanggilan tool.',
    text: `# Bang Story agent capabilities

Use named tools for projects, story and storyboard, characters, clips, overlays, media, captions, settings, models, jobs, Whisper, and export. Project data uses the same store as the browser app. Call \`project.options\` for valid language codes and visual style IDs.

Generation and story tools require explicit \`approved: true\`. Story generation also requires an \`idempotencyKey\`: use a new key for each new request and reuse that same key only when retrying it. Call \`generation.estimate\` first for image or video cost estimates. Tools never retry paid work. Long work returns job IDs; call \`jobs.get\`, \`jobs.wait\`, or \`events.wait\` for progress.

Project, scene, character, and overlay deletion, provider-key clearing, and Whisper-model removal require \`confirm: true\`. This also applies when \`project.update\` or \`editor.update\` replaces \`editor.overlays\` and removes existing overlays. Provider keys are write-only; status returns masked values. Tool results include machine-readable \`structuredContent.result\` and readable text. No tool accepts arbitrary RPC channel names or server filesystem paths.

Remote equivalents for UI controls: use \`asset.upload\` with a workspace-relative path instead of a file picker; \`clipId\` is required for image and audio uploads. Exports use the configured server destination; \`export.download\` returns an authenticated, project-scoped URL instead of opening a local folder. Clipboard actions are unnecessary: consume text and data returned by the tools. GUI-only external-link and folder-opening actions are not exposed.

## Common sequence
1. Read \`project.list\`, then \`project.get\`.
2. Call \`project.options\` before selecting a language or visual style. Add or edit scenes with \`clip.create\`, \`clip.update\`, and \`clip.delete\`; edit characters with the character tools; edit overlays with the overlay tools.
3. Estimate image/video work, then pass explicit approval to start paid jobs.
4. Wait on returned job IDs.
5. Call \`export.start\`, wait for its job, and retrieve \`export.download\` URL.
`,
  },
  'bang-story://workflows/create-video': {
    name: 'Create a video',
    description: 'Workflow for creating and exporting a Bang Story video.',
    text: `# Create a video

1. Call \`project.options\` for supported language codes and style IDs, then call \`project.create\` with synopsis, target duration, language, aspect ratio, style ID, and optional scene count.
2. Review the project with \`project.get\`.
3. Call \`story.generate_script\` with \`projectId\`, a new \`idempotencyKey\`, and \`approved: true\`; wait with \`jobs.wait\`, then review and edit scene text with \`clip.update\`.
4. Call \`story.plan_visuals\` with \`projectId\`, mode \`missing\`, a new \`idempotencyKey\`, and \`approved: true\`; wait for its job.
5. Optionally call \`story.create_music_prompt\` with \`projectId\`, a new \`idempotencyKey\`, and \`approved: true\`; wait for the job and read its prompt from \`jobs.get\`.
6. Use \`generation.estimate\` for paid image/video work. Start selected work with explicit \`approved: true\` and wait on each returned job ID.
7. After narration timing is final, call \`sound.plan\` with \`approved: true\` and a stable \`idempotencyKey\`; wait for its job. Configure captions, music, clip motion, SFX, and overlays with \`editor.update\` and \`clip.update\`.
8. Call \`export.start\`; wait for completion and fetch the authenticated URL from \`export.download\`.
`,
  },
  'bang-story://workflows/revise-storyboard': {
    name: 'Revise story and storyboard',
    description: 'Workflow for editing story text, visual plans, and characters.',
    text: `# Revise story and storyboard

1. Read \`project.get\` and note the clip and character IDs.
2. Change scene title, story, narration, visual prompt, timing, or motion using \`clip.update\`.
3. Add or remove scenes with \`clip.create\` and \`clip.delete\`; update characters with \`character.update\`; update overlays with \`overlay.create\`, \`overlay.update\`, and \`overlay.delete\`.
4. Call \`story.plan_visuals\` with mode \`missing\` to update plans that no longer match the story, or \`all\` to replace every plan. Pass a new \`idempotencyKey\` and \`approved: true\` because they call an AI provider.
5. Inspect the saved project with \`project.get\` before starting generation.
`,
  },
  'bang-story://workflows/provider-setup': {
    name: 'Set up providers',
    description: 'Configure provider credentials, endpoints, defaults, models, and voices.',
    text: `# Set up providers

1. Call \`settings.get\` to inspect non-secret defaults and \`settings.key_status\` to see which provider keys are configured. Key status only returns masked previews.
2. Store a provider key with \`settings.set_key\` for Higgsfield, Gemini, ElevenLabs, OpenRouter, Groq, or another supported provider. The tool stores and checks the key; its result never contains the raw value.
3. For an OpenAI-compatible provider, use \`settings.set_custom_endpoint\` with its HTTPS base URL and key. Use \`settings.set_ninerouter\` for 9Router. Changing either endpoint's origin requires a replacement key when one is already stored.
4. Use \`settings.update\` to choose app defaults such as the language model, text-to-speech provider, or image provider. Set a project's \`imageProvider\` with \`project.create\` or \`project.update\` to override the app default; omit it on creation to inherit that default, or set it to \`null\` to clear an existing override.
5. Call \`models.list\` for available models and \`settings.list_voices\` for voice options. Use \`settings.test_key\` to check a configured key again.

Provider keys are write-only through MCP. Never request or include a key in logs, project text, or tool results. \`settings.clear_key\` requires \`confirm: true\`.
`,
  },
  'bang-story://workflows/sound-design': {
    name: 'Scene-aware sound design',
    description: 'Plan, edit, upload and mix SFX with narration.',
    text: `# Scene-aware sound design

New projects enable SFX; existing projects retain their saved settings. ATM produce-video plans SFX after narration alignment and before export. Opening the editor does not call the language model.

1. Call \`sound.plan\` with projectId, approved:true and a stable idempotencyKey after story and narration timing are final. This uses the configured language model and may incur its charges. Poll the returned job; reuse its key after reconnecting.
2. Review editor.soundDesign in \`project.get\`. Cue startMs is relative to clipId, durationMs is trimmed at the scene end, and inMs selects a source offset. Reordering scenes keeps cues attached; splitting preserves source continuity. Manual cues protect their entire scene from automatic replacement. Story/timing changes invalidate automatic plans; replan or disable SFX before mixing.
3. Edit cues with \`editor.update\`. Each cue selects exactly one assetId or preset. Presets are deterministic abstract ambience, pulse, riser, impact and whoosh; they are not realistic environmental recordings. The planner reports missing realistic effects rather than inventing assets.
4. Upload owned/licensed audio with \`asset.upload\` kind:sfx, then record source and license with \`sound.asset_info\`. Local SFX without source/license cannot be mixed. Set bed:true for ambience to duck it with music while narration plays; accents remain separate. editor.duckMusic controls ducking, editor.normalizeAudio controls loudness normalization.
5. Call \`audio.prepare\` with a stable idempotencyKey for a local audio-mix job. Preview and export reuse the same full-duration 48 kHz stereo WAV, fingerprinted from settings, timing and active source bytes. Inputs changing during planning/mixing reject obsolete results. Export encodes that mix to AAC.
`,
  },
  'bang-story://workflows/media-and-export': {
    name: 'Media and export',
    description: 'Workflow for uploading media, captions, jobs, and exports.',
    text: `# Media and export

Upload a relative file path with \`asset.upload\`. Paths resolve only within the configured agent workspace. Use \`asset.activate\` to select an owned asset and \`asset.set_caption_words\` to edit caption text while keeping timings.

For generation, obtain a cost estimate where available and pass explicit \`approved: true\`. Track work with \`jobs.get\`, \`jobs.wait\`, or \`events.wait\`; waits are bounded and never restart work.

Start an export with project ID and output settings. Server output goes to the configured export directory. \`export.download\` returns a project-scoped URL; send the MCP bearer token in the Authorization header when fetching it.
`,
  }
}

export function registerAgentResources(server: McpServer): void {
  for (const [uri, resource] of Object.entries(resources)) {
    server.registerResource(resource.name, uri, { description: resource.description, mimeType: 'text/markdown' }, () => ({
      contents: [{ uri, mimeType: 'text/markdown', text: resource.text }]
    }))
  }
}
