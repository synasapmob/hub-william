import { GATEWAY_KEY_PLACEHOLDER } from "./utils.gateway-config";

export interface OmpInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
  includeKey?: boolean;
}

export function ompInstallCommand(options: OmpInstallCommandOptions) {
  const command = `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin}`;
  return options.includeKey
    ? `${command} --key=${GATEWAY_KEY_PLACEHOLDER}`
    : command;
}
