export const DEFAULT_WORKSPACE_PATH = '/workspace'

export const DEFAULT_MAX_OUTPUT_CHARS = 100_000

export const DEFAULT_AGENT_INSTRUCTIONS = [
  'You are operating inside a persistent session workspace.',
  'Use the available tools to inspect and modify files when required.',
  'All relative paths are resolved from /workspace.',
  'Do not claim that a file or command changed unless the relevant tool succeeded.',
].join('\n')
