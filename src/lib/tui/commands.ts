export type SlashCommandResult = 'continue' | 'exit' | undefined

export type SlashCommand = {
  name: `/${string}`
  description: string
  run: () => SlashCommandResult | Promise<SlashCommandResult>
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
  const name = input.trim().toLowerCase()
  return commands.find(command => command.name.toLowerCase() === name)
}
