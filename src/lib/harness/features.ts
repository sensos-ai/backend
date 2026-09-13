import { z } from 'zod'
import { testModelEnabled } from './providers/test-model'

export const harnessFeaturesSchema = z.object({
  useMockModel: z.boolean(),
})

export type HarnessFeatures = z.output<typeof harnessFeaturesSchema>
export type HarnessFeatureOverrides = Partial<HarnessFeatures>

/** Resolves every feature source once into a complete, transportable value. */
export function resolveHarnessFeatures(
  overrides: HarnessFeatureOverrides = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): HarnessFeatures {
  return harnessFeaturesSchema.parse({
    useMockModel: overrides.useMockModel ?? testModelEnabled(env),
  })
}
