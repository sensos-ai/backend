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
import { select } from '@inquirer/prompts'
import {
  SensosHarnessProvider,
  type HarnessLoginOptions,
  type HarnessModel,
} from '../harness-provider'
import { openBrowser } from '../auth-interaction'
import {
  beginVercelLogin,
  completeVercelLogin,
  getVercelUser,
  listVercelTeams,
  refreshVercelCredential,
} from '@/auth/oauth/vercel'

export const DEFAULT_MODEL: GatewayModelId = 'openai/gpt-5.6-terra'

export type VercelCredential = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  teamId?: string
}

export type GatewayLoginOptions = HarnessLoginOptions

export type GatewayCatalogModel = HarnessModel<GatewayModelId>

export const GATEWAY_MODEL_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'moonshotai',
  'spacexai',
])

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

export const aiGateway = (
  config: GatewayProviderSettings = {},
  credential?: VercelCredential
) => {
  return createGateway({
    apiKey:
      credential?.accessToken ?? process.env.AI_GATEWAY_API_KEY ?? '',
    ...(credential?.teamId ? { teamIdOrSlug: credential.teamId } : {}),
    ...(process.env.SENSOS_GATEWAY_BASE_URL
      ? { baseURL: process.env.SENSOS_GATEWAY_BASE_URL }
      : {}),
    ...config,
  })
}

export function createGatewayHarnessProvider(
  credential?: VercelCredential,
  dependencies: {
    config?: GatewayProviderSettings
    provider?: GatewayProvider
    fetch?: typeof fetch
    openUrl?: (url: string) => Promise<void>
    selectTeam?: (
      teams: Array<{ id: string; name: string }>
    ) => Promise<string>
    log?: (message: string) => void
    error?: (message: string) => void
  } = {}
) {
  const provider =
    dependencies.provider ?? aiGateway(dependencies.config, credential)
  return new SensosHarnessProvider({
    sensosId: 'gateway',
    authKey: 'vercel',
    provider,
    defaultModelId: DEFAULT_MODEL,
    async listModels(): Promise<readonly GatewayCatalogModel[]> {
      const { models } = await provider.getAvailableModels()
      return models
        .filter(
          model =>
            model.modelType == null || model.modelType === 'language'
        )
        .filter(model =>
          GATEWAY_MODEL_PROVIDERS.has(model.id.split('/', 1)[0] ?? '')
        )
        .map(model => ({
          id: model.id,
          name: model.id,
          ...(model.description ? { description: model.description } : {}),
        }))
    },
    auth: {
      async login(
        options: GatewayLoginOptions
      ): Promise<VercelCredential> {
        const log = dependencies.log ?? console.log
        const error = dependencies.error ?? console.error
        const openUrl = dependencies.openUrl ?? openBrowser
        log('Opening Vercel AI Gateway sign-in in your browser.')
        const device = await beginVercelLogin(options.signal)
        log(
          `Open this URL to connect Vercel AI Gateway:\n${device.verification_uri_complete}`
        )
        try {
          await openUrl(device.verification_uri_complete)
        } catch {
          error('Could not open a browser. Use the URL above.')
        }
        const oauthCredential = await completeVercelLogin(
          device,
          options.signal
        )
        const teams = await listVercelTeams(
          oauthCredential.accessToken,
          options.signal
        )
        if (teams.length === 0) {
          throw new Error(
            'No Vercel teams are available. Sensos requires a team-scoped AI Gateway account.'
          )
        }
        const teamId = dependencies.selectTeam
          ? await dependencies.selectTeam(teams)
          : await select({
              message: 'Choose the Vercel scope for AI Gateway',
              choices: teams.map(team => ({
                name: team.name,
                value: team.id,
              })),
            })
        log('Connected to Vercel AI Gateway.')
        return { ...oauthCredential, teamId }
      },
      token: value => Promise.resolve(value.accessToken),
      refresh: async value => ({
        ...(await refreshVercelCredential(value, dependencies.fetch)),
        ...(value.teamId ? { teamId: value.teamId } : {}),
      }),
      user: value => getVercelUser(value, dependencies.fetch),
    },
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
