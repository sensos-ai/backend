import {
  createGateway,
  GatewayError,
  type GatewayModelId,
  type GatewayProvider,
  type GatewayProviderSettings,
  type GatewayProviderOptions,
  type GatewaySpendReportParams,
  type GatewayGenerationInfoParams,
} from '@ai-sdk/gateway'
import { readProviderProfileSync } from '@/sensos/auth'

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

export const aiGateway = (config: GatewayProviderSettings = {}) => {
  const credential = readProviderProfileSync().vercel
  return createGateway({
    apiKey:
      credential?.accessToken ?? process.env.AI_GATEWAY_API_KEY ?? '',
    ...(credential?.teamId ? { teamIdOrSlug: credential.teamId } : {}),
    ...config,
  })
}

export const isGatewayError = (error: any): error is GatewayError =>
  GatewayError.isInstance(error)

export async function getGatewayModels(gateway: GatewayProvider) {
  return gateway.getAvailableModels()
}

export async function getCredits(gateway: GatewayProvider) {
  return gateway.getCredits()
}

export async function getSpendReport(
  gateway: GatewayProvider,
  params: GatewaySpendReportParams
) {
  return gateway.getSpendReport(params)
}

// usage
// const result = await generateText(...);
// Get the generation ID from provider metadata
// const generationId = result.providerMetadata?.gateway?.generationId;

// Look up detailed generation info
// const generation = await gateway.getGenerationInfo({ id: generationId })

// https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway#generation-lookup

export async function getGenerationInfo(
  gateway: GatewayProvider,
  params: GatewayGenerationInfoParams
) {
  return gateway.getGenerationInfo(params)
}
