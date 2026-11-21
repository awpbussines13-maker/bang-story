import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_NINE_ROUTER_IMAGE_MODEL, isValidThumbnailModel, supportsNineRouterImageReferences } from '../../src/shared/models.ts'

test('Gemini image model uses text-only generation; cx model accepts references', () => {
  assert.equal(supportsNineRouterImageReferences('ag/gemini-3.1-flash-image'), false)
  assert.equal(supportsNineRouterImageReferences('cx/gpt-image-2.5'), true)
})

test('configured FLUX thumbnail model passes validation and retains reference support', () => {
  assert.equal(isValidThumbnailModel(DEFAULT_NINE_ROUTER_IMAGE_MODEL, '9router'), true)
  assert.equal(supportsNineRouterImageReferences(DEFAULT_NINE_ROUTER_IMAGE_MODEL), true)
  assert.equal(isValidThumbnailModel('cx/gpt-image-2.5', '9router'), true)
  assert.equal(isValidThumbnailModel('gemini-3.1-flash-image', 'gemini'), true)
  for (const model of [DEFAULT_NINE_ROUTER_IMAGE_MODEL, 'cx/gpt-image-2.5']) {
    assert.equal(isValidThumbnailModel(model, 'gemini'), false)
  }
  for (const model of ['', 'cf/@cf/unknown-model', 'bad model', 'x'.repeat(101), 'model?key=value', 'model\n']) {
    assert.equal(isValidThumbnailModel(model, '9router'), false)
  }
})
