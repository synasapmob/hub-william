export interface OmpInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
}

export function ompInstallCommand(options: OmpInstallCommandOptions) {
  return `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin}`;
}
