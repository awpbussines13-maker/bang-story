import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachedReferenceUrl } from '../../src/main/referenceCache.ts'

test('reference URL cache never reuses provider or uploaded pixels after local bytes change', () => {
  const now = 1_000_000
  const source = { provider:'higgsfield',remoteUrl:'https://provider/reference.png',createdAt:now-1000,meta:{remoteFileHash:'old',uploadedUrl:'https://upload/reference.png',uploadedAt:now-500,uploadedHash:'old'} }
  assert.equal(cachedReferenceUrl(source,'new',now),null)
  assert.equal(cachedReferenceUrl({...source,meta:{...source.meta,uploadedHash:'new'}},'new',now),'https://upload/reference.png')
  assert.equal(cachedReferenceUrl({...source,meta:{...source.meta,remoteFileHash:'new'}},'new',now),'https://provider/reference.png')
  assert.equal(cachedReferenceUrl({...source,meta:{}},'new',now),null,'Legacy assets without a byte fingerprint must upload again')
  assert.equal(cachedReferenceUrl({...source,createdAt:now-7*86400000,meta:{remoteFileHash:'new'}},'new',now),null)
})
