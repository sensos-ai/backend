export function resumeArguments(args: string[]): string[] {
  const pickerIndex = args.findIndex(
    value => value === '-i' || value === '--interactive'
  )
  if (pickerIndex >= 0) {
    return [
      'picker',
      ...args.slice(0, pickerIndex),
      ...args.slice(pickerIndex + 1),
    ]
  }

  const resumeLastIndex = args.indexOf('--resume-last')
  if (resumeLastIndex >= 0) {
    return [
      'resume',
      'last',
      ...args.slice(0, resumeLastIndex),
      ...args.slice(resumeLastIndex + 1),
    ]
  }

  const exactIndex = args.findIndex(
    value => value.startsWith('--resume-') && value !== '--resume-last'
  )
  if (exactIndex >= 0) {
    const sessionId = args[exactIndex]?.slice('--resume-'.length)
    if (!sessionId) throw new Error('--resume- requires a session id')
    return [
      'resume',
      sessionId,
      ...args.slice(0, exactIndex),
      ...args.slice(exactIndex + 1),
    ]
  }

  const resumeIndex = args.indexOf('--resume')
  if (resumeIndex < 0) return args
  const candidate = args[resumeIndex + 1]
  const sessionId =
    candidate && !candidate.startsWith('-') ? candidate : 'last'
  const consumed = sessionId === 'last' && candidate !== 'last' ? 1 : 2
  return [
    'resume',
    sessionId,
    ...args.slice(0, resumeIndex),
    ...args.slice(resumeIndex + consumed),
  ]
}

export function commandArguments(args: string[]): string[] {
  const normalized = resumeArguments(args)
  if (
    normalized[0] === '--help' ||
    normalized[0] === '-h' ||
    normalized[0] === 'help'
  ) {
    return ['help']
  }
  if (normalized.length === 0 || normalized[0]?.startsWith('-')) {
    return ['new', ...normalized]
  }
  return normalized
}
