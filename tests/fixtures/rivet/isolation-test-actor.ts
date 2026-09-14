import { actor } from 'rivetkit'

export const isolationTestActor = actor({
  state: { value: '' },
  actions: {
    setValue(context, value: string) {
      context.state.value = value
    },
    getValue: context => context.state.value,
  },
})
