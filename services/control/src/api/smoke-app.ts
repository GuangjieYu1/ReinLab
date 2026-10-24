import { createApp } from './app';
import type { RuntimeConfiguration } from '../configuration';
import { pricingFromEnvironment } from '../budget/pricing';

/** The one-shot operator serves the production API, with the protected file configuration. */
export function createSmokeApp(options: Parameters<typeof createApp>[0], configuration: RuntimeConfiguration) {
  return createApp({ ...options, pricing: pricingFromEnvironment(configuration) });
}
