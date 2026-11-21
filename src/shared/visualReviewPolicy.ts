/** Existing episodes retain their historical review policy; Luma episodes enforce scene fidelity. */
export function visualReviewPolicy(identityVersion?: number | null) {
  const narrativeRequired = typeof identityVersion === 'number' && identityVersion >= 2
  return {
    version: narrativeRequired ? 'character-style-story-pixels-v3' : 'character-and-style-pixels-v2',
    narrativeRequired,
    guidance: narrativeRequired
      ? 'Also compare actual image content with story, Action and Setting. Unsupported people, creatures, threats, places or mechanisms must FAIL even when the characters and art style match. Do not excuse an invented background creature as a harmless prop. An environment-only Action must contain no people or creatures unless that Action explicitly requires them. Report unsupported background figures in unexpectedForegroundCharacters and explain the story contradiction in reason/correction. Preserve the stated location, scene action and group count; uncertainty cannot pass.'
      : 'Do not penalize ordinary background zombies or harmless props.'
  }
}
