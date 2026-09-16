import { RUNTIME_BUILD_ID } from './constants'

export function isCompatibleRuntime(response: {
  buildId?: string
}): boolean {
  return response.buildId === RUNTIME_BUILD_ID
}
