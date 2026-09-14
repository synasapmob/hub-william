import { GATEWAY_KEY_PLACEHOLDER } from "./utils.gateway-config";

export interface OpenCodeInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
  key?: string;
}

export function openCodeInstallCommand(options: OpenCodeInstallCommandOptions) {
  const key = options.key ?? GATEWAY_KEY_PLACEHOLDER;

  return `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin} --key=${key}`;
}
