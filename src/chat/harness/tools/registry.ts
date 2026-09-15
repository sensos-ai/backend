import { tool, type Tool, type ToolSet } from 'ai'
import { sandboxTools } from './sandbox'

type KnownToolName<TOOLS extends ToolSet> = Extract<keyof TOOLS, string>
type ToolName<N extends string = string> = N | (string & {})

type ToolByName<
  TOOLS extends ToolSet,
  T extends ToolName<KnownToolName<TOOLS>>,
> = T extends keyof TOOLS ? TOOLS[T] : Tool

type ObjectEntries<T> = {
  [K in keyof T]: [K, T[K]]
}[keyof T][]

export interface ToolRegistry<TOOLS extends ToolSet = {}> {
  register(name: string, tool: Tool): void
  get<T extends ToolName<KnownToolName<TOOLS>>>(
    name: T
  ): ToolByName<TOOLS, T> | undefined
  getOrThrow<T extends ToolName<KnownToolName<TOOLS>>>(
    name: T
  ): ToolByName<TOOLS, T>
  has<T extends ToolName<KnownToolName<TOOLS>>>(name: T): boolean
  list(): ToolName<KnownToolName<TOOLS>>[]
  entries(): ObjectEntries<TOOLS>
  toolset<T extends ToolSet = {}>(): T & TOOLS
}

export function createRegistry<TOOLS extends ToolSet = {}>(
  initial: TOOLS = {} as TOOLS
): ToolRegistry<TOOLS> {
  const tools = new Map<string, Tool>(Object.entries(initial))

  return {
    register: (name, tool) => {
      tools.set(name, tool)
    },
    has: name => tools.has(name),
    get: name =>
      tools.get(name) as ToolByName<TOOLS, typeof name> | undefined,
    getOrThrow: name => {
      const found = tools.get(name)
      if (!found)
        throw new Error(`Tool '${name}' does not exist in the registry.`)
      return found as ToolByName<TOOLS, typeof name>
    },
    list: () => [...tools.keys()] as ToolName<KnownToolName<TOOLS>>[],
    entries: () => [...tools.entries()] as ObjectEntries<TOOLS>,
    toolset: <T extends ToolSet = {}>() =>
      Object.fromEntries(tools.entries()) as T & TOOLS,
  }
}

interface WrapHooks {
  beforeExecute?: (input: any) => any | Promise<any>
  afterExecute?: (result: any) => any | Promise<any>
}

export function wrapTool<T extends Tool>(base: T, hooks: WrapHooks): T {
  const execute = base.execute
  return tool({
    ...base,
    ...(execute && {
      execute: async (input, options) => {
        const transformed = hooks.beforeExecute
          ? await hooks.beforeExecute(input)
          : input
        const result = await execute(transformed, options)
        return hooks.afterExecute
          ? await hooks.afterExecute(result)
          : result
      },
    }),
  }) as T
}

export const tools = createRegistry(sandboxTools)
