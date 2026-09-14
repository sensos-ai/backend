import {
  ToolLoopAgent,
  stepCountIs,
  wrapLanguageModel,
  type UIMessage,
} from 'ai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import {
  providerRegistry,
  loggingMiddleware,
  createProviderOptions,
  type ProviderOptions,
  type ModelRef,
} from './providers'
import { DEFAULT_AGENT_INSTRUCTIONS } from './constants'
import { resolveHarnessFeatures, type HarnessFeatures } from './features'
import type { Sandbox } from './sandbox'
import { sandboxTools } from './tools/sandbox'
import { startAIEventLogListener } from '@/shared/events'
import {
  appendSteeringMessages,
  type HarnessSteeringInput,
} from './steering'

startAIEventLogListener()

export interface CreateHarnessOptions {
  sandbox: Sandbox
  signal: AbortSignal
  instructions?: string
  initialMessages?: UIMessage[]
  model?: ModelRef
  maxSteps?: number
  features?: HarnessFeatures
  providerOptions?: ProviderOptions
  steeringInput?: HarnessSteeringInput
  /** Internal dependency seam for deterministic harness tests. */
  languageModel?: LanguageModelV4
}

export function createHarness(options: CreateHarnessOptions) {
  const features = resolveHarnessFeatures(options.features)
  const tools = {
    ...sandboxTools,
  }

  const toolsContext = { sandbox: options.sandbox }

  const providers = providerRegistry()
  const resolved = providers.resolveModel(options.model)
  const model =
    options.languageModel ??
    (features.useMockModel ? providers.testModel : resolved.model)

  const agent = new ToolLoopAgent({
    model: wrapLanguageModel({ model, middleware: loggingMiddleware }),
    instructions: options.instructions ?? DEFAULT_AGENT_INSTRUCTIONS,
    tools,
    toolsContext: {
      read: toolsContext,
      write: toolsContext,
      grep: toolsContext,
      bash: toolsContext,
    },
    providerOptions: createProviderOptions(
      options.providerOptions,
      options.model?.provider ?? resolved?.provider
    ),
    prepareStep: options.steeringInput
      ? async ({ messages }) => ({
          messages:
            (await appendSteeringMessages(
              messages,
              options.steeringInput as HarnessSteeringInput
            )) ?? messages,
        })
      : undefined,
    stopWhen: stepCountIs(options.maxSteps ?? 20),
  })

  return {
    agent,
    initialMessages: options.initialMessages ?? [],
    features,
    tools,
  }
}

export * from './features'
export * from './steering'

export type Harness = ReturnType<typeof createHarness>
