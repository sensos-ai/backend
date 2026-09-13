import { posix } from 'node:path'
import { DEFAULT_WORKSPACE_PATH } from '../constants'

const WORKSPACE_ROOT = DEFAULT_WORKSPACE_PATH

export function resolveWorkspacePath(input: string): string {
  const candidate = input.startsWith('/')
    ? posix.normalize(input)
    : posix.resolve(WORKSPACE_ROOT, input)

  if (
    candidate !== WORKSPACE_ROOT &&
    !candidate.startsWith(`${WORKSPACE_ROOT}/`)
  ) {
    throw new Error(`Path escapes ${WORKSPACE_ROOT}: ${input}`)
  }

  return candidate
}
