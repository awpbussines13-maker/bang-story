export interface VideoPart {
  file: string
  start: number
  own: number
  overlap: number
  pad: number
  transition: string
}

/** Limit simultaneously open decoder/filter pools regardless of the story's length. */
export function videoGroups(parts: VideoPart[]): VideoPart[][] {
  const groups: VideoPart[][] = []
  for (let i = 0; i < parts.length; i += 8) groups.push(parts.slice(i, i + 8))
  return groups
}

export function videoJoinGraph(parts: VideoPart[]): { filters: string[]; output: string } {
  const filters: string[] = []
  let output = '[0:v]'
  parts.slice(0, -1).forEach((part, i) => {
    const next = `[x${i}]`
    filters.push(`${output}[${i + 1}:v]xfade=transition=${part.transition}:duration=${part.overlap.toFixed(6)}:offset=${(parts[i + 1].start - parts[0].start).toFixed(6)}${next}`)
    output = next
  })
  return { filters, output }
}
