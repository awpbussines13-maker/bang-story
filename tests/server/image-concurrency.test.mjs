import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeNineRouterImageConcurrency } from '../../src/shared/models.ts'

test('image concurrency accepts 125 while bounding invalid settings', () => {
  assert.equal(normalizeNineRouterImageConcurrency(125), 125)
  assert.equal(normalizeNineRouterImageConcurrency(126), 125)
  assert.equal(normalizeNineRouterImageConcurrency(0), 1)
  assert.equal(normalizeNineRouterImageConcurrency(13.9), 13)
  assert.equal(normalizeNineRouterImageConcurrency(NaN), 3)
})
