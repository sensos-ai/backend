import { actor } from 'rivetkit'
import { sessionDatabase } from './db'
import {
  createState,
  createVars,
  createConnState,
  onCreate,
  onWake,
  onConnect,
  onSleep,
  onDestroy,
} from './lifecycle'
import { queues, events } from './config'
import actions from './actions'
import workflow from './workflow'

export const sessionAgent = actor({
  db: sessionDatabase,
  createState,
  onCreate,
  onWake,
  onConnect,
  createVars,
  createConnState,
  queues,
  events,
  actions,
  run: workflow,
  onSleep,
  onDestroy,
})
