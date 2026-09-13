import { describe, expect, test } from 'bun:test'
import { removeSensosProfileBlocks } from '@/cli/commands/maintenance'

describe('sensos maintenance', () => {
  test('removes only the managed sensos shell block', () => {
    expect(
      removeSensosProfileBlocks(
        [
          'export BUN_INSTALL="$HOME/.bun"',
          '# >>> sensos >>>',
          'export SENSOS_HOME="$HOME/.sensos"',
          'export PATH="$SENSOS_HOME/bin:$PATH"',
          '# <<< sensos <<<',
          'export PATH="$BUN_INSTALL/bin:$PATH"',
        ].join('\n')
      )
    ).toBe(
      [
        'export BUN_INSTALL="$HOME/.bun"',
        'export PATH="$BUN_INSTALL/bin:$PATH"',
      ].join('\n')
    )
  })

  test('preserves an incomplete managed block', () => {
    const source = '# >>> sensos >>>\nexport SENSOS_HOME=/tmp/sensos'
    expect(removeSensosProfileBlocks(source)).toBe(source)
  })
})
