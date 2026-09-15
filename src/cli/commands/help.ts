import {
  createHarnessProviderRegistry,
  harnessAuthKeys,
} from '@/chat/harness/providers'

const authKeyUsage = harnessAuthKeys(createHarnessProviderRegistry()).join(
  '|'
)

export const HELP_TEXT = `Usage: sensos [options]

Run sensos without a subcommand to start a new session.

Sessions:
  sessions                    List saved sessions for the current workspace
  session <last|id>           Resume the latest workspace session or a session by id
  sessions delete             Select and permanently delete saved sessions

Options:
  -i, --interactive           Open the session picker
  --resume [last|<id>]        Resume the latest workspace session or an exact ID
  --resume-last               Resume the latest workspace session
  --resume-<id>               Resume a session by exact ID
  --cwd <path>                Set the session workspace
  --model <id>                Set the default model
  --test-model                Use the deterministic test model
  --local-engine              Run sessions through the optional local engine
  -h, --help                  Show help

Providers:
  auth login [${authKeyUsage}]   Sign in to a model provider
  auth logout [${authKeyUsage}]  Sign out of a model provider
  auth credentials config     Configure credential storage
  login, logout               Shortcuts for auth login and auth logout
  provider <gateway|codex>    Choose the active model provider
  provider info               Show the active provider account

Runtime:
  runtime status|stop
  uninstall

Global:
  --agent, --ci               Disable interactive prompts`

export function isHelpRequest(args: readonly string[]): boolean {
  return (
    args[0] === 'help' || args.includes('--help') || args.includes('-h')
  )
}
