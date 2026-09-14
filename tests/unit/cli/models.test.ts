import { describe, expect, test } from 'bun:test'
import { commandArguments, resumeArguments } from '@/config/models'

describe('sensos models and resume arguments', () => {
  test('turns the top-level resume alias into chat session arguments', () => {
    expect(
      resumeArguments(['--resume', 'session_123', '--test-model'])
    ).toEqual(['resume', 'session_123', '--test-model'])
    expect(resumeArguments(['--resume'])).toEqual(['resume', 'last'])
    expect(resumeArguments(['--resume-last'])).toEqual(['resume', 'last'])
    expect(resumeArguments(['--resume-chat_123'])).toEqual([
      'resume',
      'chat_123',
    ])
    expect(resumeArguments(['-i', '--test-model'])).toEqual([
      'picker',
      '--test-model',
    ])
    expect(resumeArguments(['--interactive'])).toEqual(['picker'])
  })

  test('defaults flags and an empty invocation to a new session', () => {
    expect(commandArguments(['--test-model'])).toEqual([
      'new',
      '--test-model',
    ])
    expect(commandArguments([])).toEqual(['new'])
    expect(commandArguments(['sessions'])).toEqual(['sessions'])
  })

  test('routes help without treating it as a chat flag', () => {
    expect(commandArguments(['--help'])).toEqual(['help'])
    expect(commandArguments(['-h'])).toEqual(['help'])
    expect(commandArguments(['help'])).toEqual(['help'])
  })
})
