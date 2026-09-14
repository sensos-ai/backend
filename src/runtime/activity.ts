const activeWork = new Set<string>()
const listeners = new Set<(count: number) => void>()

function notify(): void {
  for (const listener of listeners) listener(activeWork.size)
}

export function retainRuntimeActivity(key: string): void {
  const previousSize = activeWork.size
  activeWork.add(key)
  if (activeWork.size !== previousSize) notify()
}

export function releaseRuntimeActivity(key: string): void {
  if (!activeWork.delete(key)) return
  notify()
}

export function runtimeActivityCount(): number {
  return activeWork.size
}

export function onRuntimeActivityChange(
  listener: (count: number) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function runtimeActivityKey(idempotencyId: string): string {
  return `run:${idempotencyId}`
}
