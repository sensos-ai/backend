import { queue } from 'rivetkit'
import type {
  QueueResultMessageForName,
  QueueSchemaConfig,
  QueueName,
  QueueFilterName,
  QueueIterOptions,
  ActorQueue,
  RunContextOf,
  AnyActorDefinition,
} from 'rivetkit'
import type { z } from 'zod'

type CompleteOutput<T> = [T] extends [never] ? never : z.output<T>

export function createQueue<
  T extends z.ZodType,
  TComplete extends z.ZodType = never,
>(schema: T, complete?: TComplete) {
  return queue<z.input<T>, CompleteOutput<TComplete>>({
    message: schema,
    complete,
  })
}

// Infer TComplete from the queue token: never → not completable, otherwise completable.
export type QueueResult<
  TQueues extends QueueSchemaConfig,
  T extends keyof TQueues,
> =
  T extends QueueName<TQueues>
    ? TQueues[T] extends ReturnType<
        typeof queue<infer _TMessage, infer TComplete>
      >
      ? [TComplete] extends [never]
        ? QueueResultMessageForName<TQueues, T, false>
        : QueueResultMessageForName<TQueues, T, true>
      : never
    : never

export function queueIterate<
  TQueues extends QueueSchemaConfig,
  const TName extends QueueFilterName<TQueues>,
  const TCompletable extends boolean = false,
>(
  queueContext: ActorQueue<TQueues>,
  options: QueueIterOptions<TName, TCompletable>
): AsyncIterable<QueueResultMessageForName<TQueues, TName, TCompletable>> {
  return queueContext.iter(options)
}

// infer the QueueSchemaConfig from the context
type QueueConfigFromContext<Ctx extends RunContextOf<AnyActorDefinition>> =
  Ctx['queue'] extends ActorQueue<infer TQueues> ? TQueues : never

export const createQueueProcessor =
  <Ctx extends RunContextOf<AnyActorDefinition>>(c: Ctx) =>
  async <
    TQueues extends QueueConfigFromContext<Ctx>,
    const TName extends QueueFilterName<TQueues>,
    const TCompletable extends boolean = false,
  >(
    options: QueueIterOptions<TName, TCompletable> & {
      process: (
        message: QueueResultMessageForName<TQueues, TName, TCompletable>
      ) => Promise<void>
    }
  ): Promise<void> => {
    for await (const message of queueIterate(c.queue, options)) {
      await options.process(message as any)
    }
  }

export async function processIterableQueue<
  Ctx extends RunContextOf<AnyActorDefinition>,
  TQueues extends QueueConfigFromContext<Ctx>,
  const TName extends QueueFilterName<TQueues>,
  const TCompletable extends boolean = false,
>(
  c: Ctx,
  options: QueueIterOptions<TName, TCompletable> & {
    process: (
      message: QueueResultMessageForName<TQueues, TName, TCompletable>
    ) => Promise<void>
  }
) {
  for await (const message of queueIterate(c.queue, options)) {
    await options.process(message as any)
  }
}
