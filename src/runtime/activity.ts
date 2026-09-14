type ActiveWork = {
  promise: Promise<void>
  resolve: () => void
}

const activeWork = new Map<string, ActiveWork>()
const listeners = new Set<(count: number) => void>()

function notify(): void {
  for (const listener of listeners) listener(activeWork.size)
}

export function retainRuntimeActivity(key: string): Promise<void> {
  const previousSize = activeWork.size
  let work = activeWork.get(key)
  if (!work) {
    let resolve = () => {}
    const promise = new Promise<void>(done => {
      resolve = done
    })
    work = { promise, resolve }
    activeWork.set(key, work)
  }
  if (activeWork.size !== previousSize) notify()
  return work.promise
}

export function releaseRuntimeActivity(key: string): void {
  const work = activeWork.get(key)
  if (!work) return
  activeWork.delete(key)
  work.resolve()
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
