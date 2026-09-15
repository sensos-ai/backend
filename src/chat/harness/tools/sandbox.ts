import { posix } from 'node:path'
import { tool } from 'ai'
import { resolveWorkspacePath } from '../utils/path'
import { decodeSandboxBytes, type Sandbox } from '../sandbox'
import { z } from 'zod'

const toolContext = z.object({
  sandbox: z.custom<Sandbox>(),
})

const readTool = tool({
  description: 'Read a UTF-8 text file from the session workspace.',
  inputSchema: z.object({
    path: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(4_000).default(400),
  }),
  contextSchema: toolContext,
  execute: async ({ path, offset, limit }, { context: { sandbox } }) => {
    const absolutePath = resolveWorkspacePath(path)
    const contents = decodeSandboxBytes(
      await sandbox.files.read(absolutePath)
    )

    const lines = contents.split('\n')
    const selected = lines.slice(offset, offset + limit)

    return {
      path: absolutePath,
      offset,
      lineCount: selected.length,
      totalLines: lines.length,
      content: selected.join('\n'),
    }
  },
})

const writeTool = tool({
  description:
    'Write a complete UTF-8 text file inside the session workspace.',
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  contextSchema: toolContext,
  execute: async ({ path, content }, { context: { sandbox } }) => {
    const absolutePath = resolveWorkspacePath(path)
    await sandbox.files.mkdir(posix.dirname(absolutePath))
    await sandbox.files.write(absolutePath, content)

    return {
      path: absolutePath,
      bytesWritten: new TextEncoder().encode(content).byteLength,
    }
  },
})

export const grepTool = tool({
  description:
    'Search workspace text files with ripgrep and return matching lines.',
  inputSchema: z.object({
    query: z.string().min(1),
    path: z.string().default('.'),
    glob: z.string().optional(),
    maxResults: z.number().int().positive().max(500).default(100),
  }),
  contextSchema: toolContext,
  execute: async (
    { query, path, glob, maxResults },
    { abortSignal, context: { sandbox } }
  ) => {
    const absolutePath = resolveWorkspacePath(path)

    const args = [
      '--line-number',
      '--color',
      'never',
      '--max-count',
      String(maxResults),
    ]

    if (glob) {
      args.push('--glob', glob)
    }

    args.push('--', query, absolutePath)

    const result = await sandbox.run(
      {
        command: 'rg',
        args,
      },
      { signal: abortSignal }
    )

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr || 'ripgrep failed')
    }

    return {
      query,
      path: absolutePath,
      matches: result.stdout,
    }
  },
})

export const bashTool = tool({
  description:
    'Run a foreground shell command in the persistent session workspace.',
  inputSchema: z.object({
    command: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(120_000),
  }),
  contextSchema: toolContext,
  execute: async (
    { command, timeoutMs },
    { context: { sandbox }, abortSignal }
  ) => {
    const result = await sandbox.run(command, {
      cwd: sandbox.cwd,
      signal: abortSignal,
      timeoutMs,
    })

    return {
      command,
      ...result,
    }
  },
})

export const sandboxTools = {
  write: writeTool,
  read: readTool,
  grep: grepTool,
  bash: bashTool,
}
