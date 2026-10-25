/** Public configuration contains no credentials; implementation stays in the .mjs adapter. */
export function accountGlobalConfiguration(options: {pluginUrl: string;model?: string}): {
  autoupdate: false;plugin: string[];model: string;small_model: string;
  enabled_providers: string[];agent:{title:{disable:true}};
};
