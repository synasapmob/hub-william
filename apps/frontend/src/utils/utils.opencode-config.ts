import { GATEWAY_KEY_PLACEHOLDER } from "./utils.gateway-config";

export interface OpenCodeInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
  includeKey?: boolean;
}

export function openCodeInstallCommand(options: OpenCodeInstallCommandOptions) {
  const command = `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin}`;
  return options.includeKey
    ? `${command} --key=${GATEWAY_KEY_PLACEHOLDER}`
    : command;
}
