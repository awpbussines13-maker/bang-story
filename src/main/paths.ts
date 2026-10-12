import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

let electronApp: any
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  electronApp = require('electron')?.app
} catch {
  electronApp = null
}

export function dataDir(): string {
  if (process.env.STUDIO_USER_DATA) return process.env.STUDIO_USER_DATA
  if (electronApp?.getPath) {
    try {
      return electronApp.getPath('userData')
    } catch {
      // not in electron runtime
    }
  }
  const dir = process.env.DATA_DIR || join(process.cwd(), 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath(): string {
  return join(dataDir(), 'studio.db')
}

export function projectsRoot(): string {
  const dir = join(dataDir(), 'projects')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function projectDir(projectId: string): string {
  const dir = join(projectsRoot(), projectId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Absolute path of an asset stored relative to its project folder. */
export function assetAbsPath(projectId: string, localPath: string): string {
  return join(projectsRoot(), projectId, localPath)
}

export function appRoot(): string {
  if (electronApp?.getAppPath) {
    try {
      return electronApp.getAppPath()
    } catch {}
  }
  return join(__dirname, '..')
}

export function fontsDir(): string {
  if (electronApp?.isPackaged) return join(process.resourcesPath, 'fonts')
  return join(appRoot(), 'resources', 'fonts')
}

/** URL the renderer uses for a stored asset (served by the studio:// protocol in Electron or /api/asset in Web). */
export function assetUrl(projectId: string, localPath: string): string {
  const rel = `${projectId}/${localPath}`.split(/[\\/]/).map(encodeURIComponent).join('/')
  if (process.env.WEB_MODE || !electronApp?.getPath) {
    return `/api/asset/${rel}`
  }
  return `studio://asset/${rel}`
}

/** ffmpeg-static / ffprobe-static paths, fixed up for the unpacked asar folder in the installed app. */
export function binPath(p: string): string {
  return p.replace('app.asar', 'app.asar.unpacked')
}
