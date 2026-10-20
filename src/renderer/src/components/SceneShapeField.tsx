import { useState } from 'react'
import {
  MAX_SCENE_COUNT,
  MAX_SCENE_SEC,
  MIN_SCENE_COUNT,
  MIN_SCENE_SEC,
  clampSceneCount,
  clampSceneSec,
  sceneTimingOf,
  suggestedSceneCount,
  suggestedSceneSec,
  wordsForMs
} from '@shared/timing'
import { Chip, cx } from './ui'

interface Props {
  /** Total video length the user picked, in seconds. */
  durationSec: number
  /** Pinned scene count, or null when the app decides. */
  count: number | null
  /** Pinned seconds per scene, or null when the app decides. */
  sec: number | null
  onChange: (v: { count: number | null; sec: number | null }) => void
  className?: string
}

/**
 * Two linked inputs: how many scenes the video has, and how many seconds each one runs. They are targets
 * for the script; a scene still plays for as long as its narration lasts, so captions stay in sync.
 */
export function SceneShapeField({ durationSec, count, sec, onChange, className }: Props) {
  const suggestedCount = suggestedSceneCount(durationSec)
  const suggestedSec = suggestedSceneSec(durationSec, suggestedCount)
  const auto = count == null && sec == null
  const timing = sceneTimingOf({ durationSec, sceneCount: count, sceneSec: sec })

  // Typing must not fight the user: keep raw text while editing so a field can be emptied or become "1".
  const [countText, setCountText] = useState<string | null>(null)
  const [secText, setSecText] = useState<string | null>(null)

  const pin = (next: { count?: number | null; sec?: number | null }): void => {
    const c = next.count !== undefined ? next.count : count
    const s = next.sec !== undefined ? next.sec : sec
    onChange({ count: c, sec: s })
  }

  /**
   * Changing the count re-divides the picked video length, so asking for 20 scenes on a one-minute video
   * gives 3 seconds each instead of silently turning it into a 5-minute video. The user can then raise
   * the seconds per scene on purpose, and the hint says when the total no longer matches.
   *
   * `typing` keeps the field showing exactly what was typed ("1" on the way to "12") while the parent
   * still gets an already-clamped value; otherwise the clamped value would rewrite the input mid-word.
   */
  const commitCount = (raw: string, typing = false): void => {
    setCountText(typing ? raw : null)
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return pin({ count: null })
    const next = clampSceneCount(n)
    // Only re-divide when the clamped count actually differs, so typing "1" then "2" does not jump to 3s.
    if (next === count) return
    pin({ count: next, sec: suggestedSceneSec(durationSec, next) })
  }

  const commitSec = (raw: string, typing = false): void => {
    setSecText(typing ? raw : null)
    const n = Number.parseInt(raw, 10)
    pin({ sec: Number.isFinite(n) ? clampSceneSec(n) : null })
  }

  const totalSec = Math.round(timing.budgetMs / 1000)

  return (
    <div className={cx('flex flex-col gap-2.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Adegan</span>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input
            type="number"
            inputMode="numeric"
            min={MIN_SCENE_COUNT}
            max={MAX_SCENE_COUNT}
            value={countText ?? (count ?? suggestedCount)}
            onChange={(e) => {
              // Commit on every keystroke: the hint and the other field read from the parent, so committing
              // only on blur would leave the UI one edit behind. Out-of-range values snap back immediately,
              // so the field can never show a number the app rejected.
              const raw = e.target.value
              if (raw === '') {
                setCountText('')
                return pin({ count: null })
              }
              const n = Number.parseInt(raw, 10)
              if (!Number.isFinite(n)) return
              if (n < MIN_SCENE_COUNT || n > MAX_SCENE_COUNT) return commitCount(raw)
              commitCount(raw, true)
            }}
            onBlur={(e) => commitCount(e.target.value)}
            aria-label="Jumlah adegan"
            className="h-9 w-[68px] rounded-full border border-line-2 bg-surface px-3 text-sm text-ink outline-none focus:border-ink"
          />
          adegan
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input
            type="number"
            inputMode="numeric"
            min={MIN_SCENE_SEC}
            max={MAX_SCENE_SEC}
            value={secText ?? (sec ?? suggestedSec)}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') {
                setSecText('')
                return pin({ sec: null })
              }
              const n = Number.parseInt(raw, 10)
              if (!Number.isFinite(n)) return
              if (n < MIN_SCENE_SEC || n > MAX_SCENE_SEC) return commitSec(raw)
              commitSec(raw, true)
            }}
            onBlur={(e) => commitSec(e.target.value)}
            aria-label="Detik per adegan"
            className="h-9 w-[68px] rounded-full border border-line-2 bg-surface px-3 text-sm text-ink outline-none focus:border-ink"
          />
          detik/adegan
        </label>
        {auto ? null : (
          <Chip on={auto} onClick={() => onChange({ count: null, sec: null })} className="h-9">
            Pakai otomatis
          </Chip>
        )}
      </div>
      <p className="text-[13px] text-muted">
        {auto
          ? `Otomatis: sekitar ${suggestedCount} adegan, ± ${suggestedSec} detik tiap adegan.`
          : `${timing.count} adegan × ± ${Math.round(timing.targetMs / 1000)} detik = sekitar ${totalSec} detik (target ${Math.round(timing.plannedMs / 1000)} detik). Naskah ditulis ± ${wordsForMs(timing.targetMs)} kata per adegan.`}
        {timing.over ? (
          <span className="text-[#B4552D]"> Totalnya lebih panjang dari durasi yang kamu pilih.</span>
        ) : null}
      </p>
    </div>
  )
}
