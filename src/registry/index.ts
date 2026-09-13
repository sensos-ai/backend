import { setup } from 'rivetkit'
import { sessionAgent } from './actors/session'

const registry = setup({
  use: {
    session: sessionAgent,
  },
})

export default registry
