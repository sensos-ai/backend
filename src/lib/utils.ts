import { createIdGenerator } from 'ai'

type PrefixedId<T extends string> = `${T}_${string}` & string

export const createIdGeneratorWithPrefix = <T extends string>(prefix: T) =>
  createIdGenerator({
    prefix,
    size: 24,
    separator: '_',
  }) as () => PrefixedId<T>

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
