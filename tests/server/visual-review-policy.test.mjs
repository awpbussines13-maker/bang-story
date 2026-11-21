import assert from 'node:assert/strict'
import test from 'node:test'
import { visualReviewPolicy } from '../../src/shared/visualReviewPolicy.ts'

test('Luma review policy cannot reuse approval hashes from the historical visual-only policy', () => {
  const old = visualReviewPolicy(1)
  const current = visualReviewPolicy(2)
  assert.equal(old.narrativeRequired, false)
  assert.equal(current.narrativeRequired, true)
  assert.notEqual(old.version, current.version)
  assert.equal(visualReviewPolicy(3).version, current.version)
  assert.match(current.guidance, /Unsupported people, creatures, threats, places or mechanisms must FAIL/)
  assert.doesNotMatch(current.guidance, /Do not penalize ordinary background zombies/)
})

test('legacy projects and existing identity revision one keep their captured approval policy', () => {
  for (const version of [undefined, null, 0, 1]) {
    assert.equal(visualReviewPolicy(version).version, 'character-and-style-pixels-v2')
    assert.equal(visualReviewPolicy(version).narrativeRequired, false)
  }
})
