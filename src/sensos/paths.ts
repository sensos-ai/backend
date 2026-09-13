import { homedir } from 'node:os'
import { join } from 'node:path'

type ProductPathOptions = {
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
}

export function productConfigDir(
  options: ProductPathOptions = {}
): string {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  if (platform !== 'win32' && env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, 'sensos')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'sensos')
  }
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'sensos')
  }
  return join(home, '.config', 'sensos')
}

export function productStateDir(options: ProductPathOptions = {}): string {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  if (platform !== 'win32' && env.XDG_STATE_HOME) {
    return join(env.XDG_STATE_HOME, 'sensos')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'sensos')
  }
  if (platform === 'win32') {
    return join(
      env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
      'sensos'
    )
  }
  return join(home, '.local', 'state', 'sensos')
}

export function sessionCatalogPath(root = productStateDir()): string {
  return join(root, 'catalog.sqlite')
}
