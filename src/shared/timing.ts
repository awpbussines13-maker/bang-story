import { clipCountFor } from './models'
import { estimateNarrationMs } from './script'
import type { Project } from './types'

/**
 * The user can pin how many scenes a video has and how many seconds each scene should run. Both are
 * *targets* for the script: the real length of a scene is always the length of its voiced narration, so
 * captions, lyrics and the timeline keep following the audio. Pinning only changes how much is written
 * (scene count and words per scene), never how long the measured audio is played.
 *
 * Null means "let the app decide", which is the old behaviour: one scene every ~5.5 seconds.
 */

/** A scene still needs at least two seconds of voice to be watchable. */
export const MIN_SCENE_SEC = 2
/** Longer than this and a single still visual gets boring. */
export const MAX_SCENE_SEC = 60
export const MIN_SCENE_COUNT = 3
export const MAX_SCENE_COUNT = 120

export interface SceneTiming {
  /** How many scenes the script should have. */
  count: number
  /** Target length of one scene, in ms. */
  targetMs: number
  /** Target length of the whole video, in ms: count × target. */
  budgetMs: number
  /** Total video length the user picked, in ms. */
  plannedMs: number
  /** True when count × target overshoots the picked video length. */
  over: boolean
}

/** Rounds to a whole second and keeps the value inside the allowed range. */
export function clampSceneSec(sec: number): number {
  if (!Number.isFinite(sec)) return MIN_SCENE_SEC
  return Math.min(MAX_SCENE_SEC, Math.max(MIN_SCENE_SEC, Math.round(sec)))
}

export function clampSceneCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_SCENE_COUNT
  return Math.min(MAX_SCENE_COUNT, Math.max(MIN_SCENE_COUNT, Math.round(n)))
}

/**
 * Turns the project's pins into the numbers every other step uses. Unpinned values fall back to the
 * video length, so projects made before this setting existed behave exactly as they used to.
 */
export function sceneTimingOf(
  project: Pick<Project, 'durationSec' | 'sceneCount' | 'sceneSec'>
): SceneTiming {
  const plannedMs = Math.max(1000, Math.round(project.durationSec) * 1000)
  const count = project.sceneCount == null ? clipCountFor(project.durationSec) : clampSceneCount(project.sceneCount)
  // A pinned scene length wins over the average, because the user asked for it explicitly.
  const targetMs =
    project.sceneSec != null
      ? clampSceneSec(project.sceneSec) * 1000
      : Math.round(plannedMs / Math.max(1, count) / 100) * 100
  return {
    count,
    targetMs,
    budgetMs: count * targetMs,
    plannedMs,
    over: count * targetMs > plannedMs * 1.05
  }
}

/**
 * How many spoken words fit the target scene length. estimateNarrationMs is the inverse of this
 * (≈2.6 words per second plus a breath), so writing to this budget makes scenes land near the target.
 *
 * estimateNarrationMs is only used before a voice exists and it clamps at 15s, so no word budget can
 * describe a longer still scene. The real audio is never clamped: a clip always takes its length from the
 * recorded voice, which is why a long scene still plays in full and stays in sync with its captions.
 */
export function wordsForMs(ms: number): number {
  return Math.max(4, Math.round((ms / 1000 - 0.6) * 2.6))
}

/** Suggested count for a given video length, used to prefill the picker. */
export function suggestedSceneCount(durationSec: number): number {
  return clampSceneCount(clipCountFor(durationSec))
}

/** Suggested seconds per scene for a given video length, used to prefill the picker. */
export function suggestedSceneSec(durationSec: number, count: number): number {
  return clampSceneSec(durationSec / Math.max(1, count))
}

/** Rough total length once the script is voiced, from the estimates. Used for the UI hint only. */
export function estimateTotalMs(narrations: string[]): number {
  return narrations.reduce((n, text) => n + estimateNarrationMs(text), 0)
}
