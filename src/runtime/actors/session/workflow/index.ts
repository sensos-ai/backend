import { workflow } from 'rivetkit/workflow'
import type { RunWorkflow } from '../types'
import { executeRun, processInbox, submitRun } from './steps'

export const runWorkflow: RunWorkflow = async context => {
  await context.loop('runs', async loop => {
    const received = await loop.race('next-work', [
      { name: 'run', run: branch => submitRun(branch) },
      { name: 'inbox', run: branch => processInbox(branch) },
    ])

    if (received.value.kind === 'inbox') return
    const { command, submission } = received.value
    if (!submission.accepted || submission.deduplicated) return

    await loop.race(`execute-run-${submission.runId}`, [
      {
        name: 'execute',
        run: branch =>
          executeRun(branch, { command, runId: submission.runId }),
      },
      {
        name: 'inbox',
        run: branch =>
          branch.loop(
            `active-inbox-${submission.runId}`,
            async inboxLoop => {
              await processInbox(inboxLoop, 'next-active-inbox')
            }
          ),
      },
    ])
  })
}

export default workflow(runWorkflow)
