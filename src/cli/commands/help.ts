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
  -h, --help                  Show help

Providers:
  login [${authKeyUsage}]        Sign in to a model provider
  logout [${authKeyUsage}]       Sign out of a model provider
  provider <gateway|codex>    Choose the active model provider

Runtime:
  runtime status|stop
  uninstall`

export function isHelpRequest(args: string[]): boolean {
  return (
    args[0] === 'help' || args.includes('--help') || args.includes('-h')
  )
}
