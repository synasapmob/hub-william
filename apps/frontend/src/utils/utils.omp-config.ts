import { GATEWAY_KEY_PLACEHOLDER } from "./utils.gateway-config";

export interface OmpInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
  key?: string;
}

export function ompInstallCommand(options: OmpInstallCommandOptions) {
  const key = options.key ?? GATEWAY_KEY_PLACEHOLDER;

  return `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin} --key=${key}`;
}
