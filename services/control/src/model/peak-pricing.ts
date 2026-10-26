import { DEEPSEEK_PRICING_VERSION } from "../bridge/openscience/deepseek-pricing";
/** Constant conservative peak estimate; no calendar or price-window freezing.
 * The full-range fields retain compatibility with the existing ledger protocol. */
export function localPeakPricing() {
 return Object.freeze({currency:"CNY" as const,window:"peak" as const,usdCnyRate:"7.2" as const,pricingVersion:DEEPSEEK_PRICING_VERSION,validFrom:0,validUntil:Number.MAX_SAFE_INTEGER});
}
