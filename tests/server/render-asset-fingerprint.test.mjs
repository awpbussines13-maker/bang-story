import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderAssetFingerprint } from '../../src/main/renderAssetFingerprint.ts'

test('caption alignment and changed bytes invalidate rendering even with stable IDs, sizes and timestamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-fingerprint-'))
  try {
    const file = join(dir, 'voice.wav')
    writeFileSync(file, 'audio-one')
    const asset = { id:'voice', kind:'audio', durationMs:1000, width:null, height:null, meta:{ words:[{text:'Hello',start:0,end:0.5}] } }
    const before = renderAssetFingerprint(asset, file)
    const aligned = renderAssetFingerprint({ ...asset, meta:{ words:[{text:'Hello',start:0.2,end:0.7}] } }, file)
    assert.notDeepEqual(before, aligned)
    const times = statSync(file)
    writeFileSync(file, 'audio-two')
    utimesSync(file, times.atime, times.mtime)
    assert.notDeepEqual(before, renderAssetFingerprint(asset, file))
    assert.deepEqual(renderAssetFingerprint(asset, file), renderAssetFingerprint({...asset,meta:{...asset.meta,uploadedUrl:'temporary provider URL'}},file))
    rmSync(file)
    assert.notDeepEqual(before, renderAssetFingerprint(asset, file))
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
