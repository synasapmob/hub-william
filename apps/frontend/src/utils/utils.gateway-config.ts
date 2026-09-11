/**
 * Agent config the gateway installer writes, as copyable snippets.
 *
 * The Python installer is what actually mutates the files. These strings exist
 * so `/tools?node=gateway` can show the same blocks for someone who already
 * has a key and wants to paste them by hand.
 */

export const GATEWAY_KEY_PLACEHOLDER = "YOUR_GATEWAY_KEY";

export interface GatewayAgentConfig {
  agent: "claude" | "codex" | "grok";
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
  key?: string;
}

export function gatewayInstallCommand(options: GatewayInstallCommandOptions) {
  const key = options.key ?? GATEWAY_KEY_PLACEHOLDER;

  return `curl -fsSL ${options.installerUrl} | python3 - --url=${options.gatewayOrigin} --key=${key}`;
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
  const openaiBaseUrl = `${origin}/gateway/openai/v1`;
  const claudeBaseUrl = `${origin}/gateway/claude`;
  const grokBaseUrl = `${origin}/gateway/grok/v1`;

  return [
    {
      agent: "codex",
      label: "Codex",
      path: "~/.codex/config.toml",
      protocol: "OpenAI Responses",
      source: [
        `model_provider = "hub-william"`,
        "",
        "[model_providers.hub-william]",
        `name = "Hub William"`,
        `base_url = "${openaiBaseUrl}"`,
        `experimental_bearer_token = "${key}"`,
        `wire_api = "responses"`,
        "",
      ].join("\n"),
    },
    {
      agent: "claude",
      label: "Claude Code",
      path: "~/.claude/settings.json",
      protocol: "Anthropic Messages",
      source: `${JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: claudeBaseUrl,
            ANTHROPIC_AUTH_TOKEN: key,
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      agent: "grok",
      label: "Grok",
      path: "~/.grok/config.toml",
      protocol: "OpenAI-compatible chat",
      source: [
        "[endpoints]",
        `models_base_url = "${grokBaseUrl}"`,
        "",
        "[model.grok-build]",
        `base_url = "${grokBaseUrl}"`,
        `api_key = "${key}"`,
        "",
      ].join("\n"),
    },
  ];
}
