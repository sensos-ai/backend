import { describe, expect, test } from 'bun:test'
import { productConfigDir, productStateDir } from '@/config/paths'

describe('sensos product paths', () => {
  test('uses XDG config and state roots when configured', () => {
    const options = {
      platform: 'linux' as const,
      home: '/home/tester',
      env: {
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_STATE_HOME: '/xdg/state',
      },
    }
    expect(productConfigDir(options)).toBe('/xdg/config/sensos')
    expect(productStateDir(options)).toBe('/xdg/state/sensos')
  })

  test('uses the XDG fallback locations on Linux', () => {
    const options = {
      platform: 'linux' as const,
      home: '/home/tester',
      env: {},
    }
    expect(productConfigDir(options)).toBe('/home/tester/.config/sensos')
    expect(productStateDir(options)).toBe(
      '/home/tester/.local/state/sensos'
    )
  })

  test('uses native macOS locations', () => {
    const options = {
      platform: 'darwin' as const,
      home: '/Users/tester',
      env: {},
    }
    expect(productConfigDir(options)).toBe(
      '/Users/tester/Library/Application Support/sensos'
    )
    expect(productStateDir(options)).toBe(
      '/Users/tester/Library/Application Support/sensos'
    )
  })

  test('uses roaming config and local state on Windows', () => {
    expect(
      productConfigDir({
        platform: 'win32',
        home: 'C:\\Users\\tester',
        env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      })
    ).toBe('C:\\Users\\tester\\AppData\\Roaming/sensos')
    expect(
      productStateDir({
        platform: 'win32',
        home: 'C:\\Users\\tester',
        env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      })
    ).toBe('C:\\Users\\tester\\AppData\\Local/sensos')
  })
})
