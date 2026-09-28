import providerCatalogue from "@/services/provider-catalogue";

/**
 * Agent config the gateway installer writes, as copyable snippets.
 *
 * The Python installer is what actually mutates the files. These strings exist
 * so `/tools?node=gateway` can show the same blocks for someone who already
 * has a key and wants to paste them by hand.
 */

export const GATEWAY_KEY_PLACEHOLDER = "YOUR_GATEWAY_KEY";

export interface GatewayAgentConfig {
  agent: "agy-settings" | "agy-shell" | "claude" | "codex" | "grok";
  label: string;
  path: string;
  protocol: string;
  source: string;
}

export interface ResolveGatewayOriginOptions {
  apiBaseUrl?: string;
}

export function resolveGatewayOrigin(
  siteOrigin: string,
  options: ResolveGatewayOriginOptions = {},
) {
  const apiBaseUrl =
    options.apiBaseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    "http://localhost:8080";

  return new URL(apiBaseUrl, `${siteOrigin}/`).toString().replace(/\/$/, "");
}

export interface GatewayInstallCommandOptions {
  gatewayOrigin: string;
  installerUrl: string;
}

export function gatewayInstallCommand(options: GatewayInstallCommandOptions) {
  return `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin}`;
}

export interface GatewayAgentConfigsOptions {
  key?: string;
}

export function gatewayAgentConfigs(
  gatewayOrigin: string,
  options: GatewayAgentConfigsOptions = {},
): GatewayAgentConfig[] {
  const origin = gatewayOrigin.replace(/\/$/, "");
  const key = options.key ?? GATEWAY_KEY_PLACEHOLDER;
  return providerCatalogue
    .list("installers")
    .flatMap((provider): GatewayAgentConfig[] => {
      const client = provider.native_cli;
      if (!client) return [];
      const baseUrl = origin + client.base_path;
      const common = {
        label: client.label,
        path: "~/" + client.path,
        protocol: client.protocol,
      };
      switch (client.id) {
        case "codex":
          return [
            {
              ...common,
              agent: "codex",
              source: [
                `model_provider = "hub-william"`,
                "",
                "[model_providers.hub-william]",
                `name = "Hub William"`,
                `base_url = "${baseUrl}"`,
                `experimental_bearer_token = "${key}"`,
                `wire_api = "${client.wire_api}"`,
                "",
              ].join("\n"),
            },
          ];
        case "claude":
          return [
            {
              ...common,
              agent: "claude",
              source: `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key } }, null, 2)}\n`,
            },
          ];
        case "agy":
          return [
            {
              ...common,
              agent: "agy-settings",
              label: `${client.label} settings`,
              source: `${JSON.stringify({ modelProvider: client.model_provider }, null, 2)}\n`,
            },
            {
              ...common,
              agent: "agy-shell",
              label: `${client.label} environment`,
              path: "~/.zshrc, ~/.bashrc, or ~/.profile",
              source: [
                "# >>> hub-william agy >>>",
                `export GOOGLE_GEMINI_BASE_URL='${baseUrl}'`,
                `export GEMINI_API_KEY='${key}'`,
                "# <<< hub-william agy <<<",
                "",
              ].join("\n"),
            },
          ];
        case "grok":
          return [
            {
              ...common,
              agent: "grok",
              source: [
                "[endpoints]",
                `models_base_url = "${baseUrl}"`,
                "",
                `[model.${client.model_key}]`,
                `base_url = "${baseUrl}"`,
                `api_key = "${key}"`,
                "",
              ].join("\n"),
            },
          ];
      }
    });
}
