import { z } from 'zod'

export const characterVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  styleMatches: z.boolean(),
  styleIssues: z.array(z.string().max(1000)),
  checks: z.array(z.object({
    characterId: z.string(), visible: z.boolean(), identityMatches: z.boolean(),
    issues: z.array(z.string().max(1000))
  }).strict()).max(100),
  unexpectedForegroundCharacters: z.array(z.string().max(1000)),
  reason: z.string().min(1).max(4000),
  correction: z.string().max(4000)
}).strict()

export type CharacterVerdict = z.infer<typeof characterVerdictSchema>
export interface CharacterSceneReview {
  clipId: string
  scene: number
  title: string
  assetId: string | null
  status: 'pass' | 'fail' | 'uncertain' | 'unreviewed' | 'blocked' | 'best-effort' | 'manual'
  reason: string
  inputHash: string | null
}
export interface CharacterConsistencyStatus {
  projectId: string
  required: boolean
  ready: boolean
  passed: number
  total: number
  scenes: CharacterSceneReview[]
  styleReference: { assetId: string; url: string } | null
}
