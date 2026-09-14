export interface WaitOptions {
  description: string
  timeoutMs?: number
  intervalMs?: number
}

export function waitForEvent<T>(
  subscribe: (listener: (event: T) => void) => () => void,
  predicate: (event: T) => boolean,
  options: WaitOptions
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for ${options.description}`))
    }, options.timeoutMs ?? 10_000)
    const unsubscribe = subscribe(event => {
      if (!predicate(event)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

export async function waitForValue<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitOptions
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  let value = await read()

  while (!predicate(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${options.description}`)
    }
    await Bun.sleep(options.intervalMs ?? 25)
    value = await read()
  }

  return value
}
