export type DeliveryPriority = 'now' | 'next' | 'adaptive'

export type SlashCommandResult =
  | 'continue'
  | 'exit'
  | 'switch-session'
  | { prompt: string; priority: DeliveryPriority }
  | undefined

export type SlashCommand = {
  name: `/${string}`
  argumentHint?: `<${string}>`
  description: string
  run: (
    argument?: string
  ) => SlashCommandResult | Promise<SlashCommandResult>
}

export function matchingSlashCommands(
  input: string,
  commands: readonly SlashCommand[]
): SlashCommand[] {
  if (!input.startsWith('/') || input.includes(' ')) return []
  const query = input.toLowerCase()
  return commands.filter(command =>
    command.name.toLowerCase().startsWith(query)
  )
}

export function slashCommandCompletion(
  input: string,
  commands: readonly SlashCommand[]
): SlashCommand | undefined {
  const matches = matchingSlashCommands(input, commands)
  if (matches.length !== 1) return undefined

  const [command] = matches
  return command && command.name.length > input.length
    ? command
    : undefined
}

export function findSlashCommand(
  input: string,
  commands: readonly SlashCommand[]
): SlashCommand | undefined {
  const [name] = input.trim().toLowerCase().split(/\s+/, 1)
  return commands.find(command => command.name.toLowerCase() === name)
}

export function slashCommandArgument(input: string): string | undefined {
  const argument = input
    .trim()
    .replace(/^\/\S+\s*/, '')
    .trim()
  return argument || undefined
}

export type StreamingInput =
  | { type: 'delivery'; prompt: string; priority: DeliveryPriority }
  | { type: 'exit' }
  | { type: 'switch-session' }
  | { type: 'stop' }

export function parseStreamingInput(input: string): StreamingInput {
  const trimmed = input.trim()
  if (/^\/switch-session$/i.test(trimmed)) {
    return { type: 'switch-session' }
  }
  if (/^\/stop$/i.test(trimmed)) return { type: 'stop' }

  const command = trimmed.match(/^\/(interrupt|queue)(?:\s+([\s\S]+))?$/i)
  if (!command) {
    return { type: 'delivery', prompt: input, priority: 'adaptive' }
  }
  const prompt = command[2]?.trim()
  if (!prompt) {
    throw new Error(`Usage: /${command[1]?.toLowerCase()} <message>`)
  }
  return {
    type: 'delivery',
    prompt,
    priority: command[1]?.toLowerCase() === 'interrupt' ? 'now' : 'next',
  }
}
