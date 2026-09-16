import {
  createGateway,
  GatewayError,
  type GatewayModelId,
  type GatewayProviderOptions,
  type GatewayProviderSettings,
} from '@ai-sdk/gateway'

export const DEFAULT_MODEL: GatewayModelId = 'openai/gpt-5.6-terra'

export type TypedGatewayProviderOptions = Omit<
  GatewayProviderOptions,
  'byok'
> & {
  byok?: Partial<Record<'openai' | 'anthropic', { apiKey: string }[]>>
}

export function createGatewayOptions(
  opts: TypedGatewayProviderOptions = {}
): GatewayProviderOptions {
  const openaiApiKey =
    process.env.OPENAI_API_KEY ?? process.env.OPEN_AI_API_KEY ?? ''
  return {
    ...opts,
    byok: {
      ...opts.byok,
      openai:
        opts.byok?.openai ??
        (openaiApiKey ? [{ apiKey: openaiApiKey }] : []),
    },
    models: [DEFAULT_MODEL, 'anthropic/claude-3-haiku'],
  } satisfies TypedGatewayProviderOptions
}

export const aiGateway = (config: GatewayProviderSettings = {}) =>
  createGateway({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    ...(process.env.SENSOS_GATEWAY_BASE_URL
      ? { baseURL: process.env.SENSOS_GATEWAY_BASE_URL }
      : {}),
    ...config,
  })

export const isGatewayError = (error: unknown): error is GatewayError =>
  GatewayError.isInstance(error)
