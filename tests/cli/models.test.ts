import { describe, expect, test } from 'bun:test'
import {
  CHAT_MODELS,
  commandArguments,
  resumeArguments,
} from '@/sensos/models'

describe('sensos models and resume arguments', () => {
  test('uses the three explicit gateway model ids', () => {
    expect(CHAT_MODELS.map(model => model.name)).toEqual([
      'anthropic/claude-fable-5',
      'openai/gpt-5.6-sol',
      'openai/gpt-6-astra',
    ])
    expect(CHAT_MODELS.map(model => model.value)).toEqual([
      'anthropic/claude-fable-5',
      'openai/gpt-5.6-sol',
      'openai/gpt-6-astra',
    ])
  })

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
