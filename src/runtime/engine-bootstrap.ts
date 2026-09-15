#!/usr/bin/env bun

import { runRuntimeSupervisor } from './index'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined
if (!root) throw new Error('Runtime supervisor requires --root')

await runRuntimeSupervisor(root)
