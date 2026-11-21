import test from 'node:test'
import assert from 'node:assert/strict'
import { whisperExecutable } from '../../src/main/whisperPath.ts'

test('caption alignment selects native executable while preserving Windows and explicit installations', () => {
  assert.equal(whisperExecutable('/app/resources', 'linux'), '/app/resources/whisper/whisper-cli')
  assert.equal(whisperExecutable('/app/resources', 'win32'), '/app/resources/whisper/whisper-cli.exe')
  assert.equal(whisperExecutable('/app/resources', 'darwin'), '/app/resources/whisper/whisper-cli')
  assert.equal(whisperExecutable('/app/resources', 'linux', '/opt/whisper-cli'), '/opt/whisper-cli')
})
