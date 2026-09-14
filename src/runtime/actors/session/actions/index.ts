import type { SessionActions } from '../types'
import { deliver } from './deliver'
import { cancel, getRun, streamSnapshot } from './runs'
import {
  deleteSession,
  getSession,
  setFeatures,
  setModel,
} from './session'

export default {
  cancel,
  deliver,
  deleteSession,
  getRun,
  getSession,
  setFeatures,
  setModel,
  streamSnapshot,
} satisfies SessionActions
