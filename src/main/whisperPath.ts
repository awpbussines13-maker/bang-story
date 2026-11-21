import { join } from 'node:path'

export function whisperExecutable(resourceRoot: string, platform: string, override?: string): string {
  return override?.trim() || join(resourceRoot, 'whisper', platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
}
