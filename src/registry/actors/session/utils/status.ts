import type { ChatStatus } from 'ai'
import type { RunStatus } from '../db'

export type SessionRunStatus = 'idle' | RunStatus

export function toChatStatus(status: SessionRunStatus): ChatStatus {
  switch (status) {
    case 'idle':
    case 'completed':
    case 'cancelled':
      return 'ready'
    case 'queued':
      return 'submitted'
    case 'running':
    case 'cancel_requested':
      return 'streaming'
    case 'failed':
    case 'interrupted':
      return 'error'
  }
}
