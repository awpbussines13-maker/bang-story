import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export function resolveAgentFile(relativePath: string, rootPath = process.env.BANG_STORY_AGENT_FILES_DIR || resolve(process.cwd(), 'agent-files')): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('Upload path must stay inside the configured agent workspace')
  }
  if (!existsSync(rootPath)) mkdirSync(rootPath, { recursive: true })
  let root: string
  let file: string
  try {
    root = realpathSync(rootPath)
    file = realpathSync(resolve(root, relativePath))
  } catch {
    throw new Error('Upload source is unavailable')
  }
  const rel = relative(root, file)
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Upload path must stay inside the configured agent workspace')
  }
  if (!statSync(file).isFile()) throw new Error('Upload source must be a regular file')
  return file
}
