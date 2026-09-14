export type DeliveryPriority = 'now' | 'next' | 'adaptive'

export type SlashCommandResult =
  | 'continue'
  | 'exit'
  | { prompt: string; priority: DeliveryPriority }
  | undefined

export type SlashCommand = {
  name: `/${string}`
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

export function parseStreamingDelivery(input: string): {
  prompt: string
  priority: DeliveryPriority
} {
  const trimmed = input.trim()
  const command = trimmed.match(/^\/(interrupt|queue)(?:\s+([\s\S]+))?$/i)
  if (!command) return { prompt: input, priority: 'adaptive' }
  const prompt = command[2]?.trim()
  if (!prompt) {
    throw new Error(`Usage: /${command[1]?.toLowerCase()} <message>`)
  }
  return {
    prompt,
    priority: command[1]?.toLowerCase() === 'interrupt' ? 'now' : 'next',
  }
}
