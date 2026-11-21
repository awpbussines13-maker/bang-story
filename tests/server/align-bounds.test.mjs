import test from 'node:test'
import assert from 'node:assert/strict'
import { alignWords, boundWordTimings } from '../../src/main/align.ts'
test('decoder EOF overruns and overlapping word segments stay within real audio', () => {
 const words=boundWordTimings([{text:'one',start:-.1,end:.4},{text:'two',start:.34,end:.6},{text:'three',start:.6,end:3}],1)
 assert.deepEqual(words,[{text:'one',start:0,end:.34},{text:'two',start:.34,end:.6},{text:'three',start:.6,end:1}])
})
test('alignment retains script spelling and bounds missing trailing words', () => {
 const out=alignWords(['You','ration','oats','beside','the','stove.','Eighteen','liters.'],[{text:'You',start:0,end:.3},{text:'ration',start:.3,end:.6},{text:'oats',start:.6,end:.9},{text:'beside',start:.9,end:1.1},{text:'the',start:1.1,end:1.3},{text:'stove',start:1.3,end:3}],2)
 assert.equal(out.map(w=>w.text).join(' '),'You ration oats beside the stove. Eighteen liters.')
 for(let i=0;i<out.length;i++){assert.ok(out[i].start>=0);assert.ok(out[i].end>=out[i].start);assert.ok(out[i].end<=2);if(i)assert.ok(out[i].start>=out[i-1].end)}
})
