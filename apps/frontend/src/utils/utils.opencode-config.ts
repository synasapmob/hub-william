export interface OpenCodeInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
}

export function openCodeInstallCommand(options: OpenCodeInstallCommandOptions) {
  return `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin}`;
}
