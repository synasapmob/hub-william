import { describe, expect, it } from "vitest";

import {
  GATEWAY_KEY_PLACEHOLDER,
  gatewayAgentConfigs,
  gatewayInstallCommand,
  resolveGatewayOrigin,
} from "./utils.gateway-config";

describe("resolveGatewayOrigin", () => {
  it("keeps an absolute API origin", () => {
    expect(
      resolveGatewayOrigin("https://hub.example", {
        apiBaseUrl: "http://localhost:8080/",
      }),
    ).toBe("http://localhost:8080");
  });

  it("resolves a same-origin /api prefix against the site", () => {
    expect(
      resolveGatewayOrigin("https://hub.example", { apiBaseUrl: "/api" }),
    ).toBe("https://hub.example/api");
  });
});

describe("gatewayInstallCommand", () => {
  it("pipes gateway.py into python3 with --url and --key like install.py", () => {
    expect(
      gatewayInstallCommand({
        gatewayOrigin: "https://hub.example/api",
        installerUrl: "https://hub.example/gateway.py",
      }),
    ).toBe(
      "curl -fsSL https://hub.example/gateway.py | python3 - --url=https://hub.example/api --key=YOUR_GATEWAY_KEY",
    );
  });
});

describe("gatewayAgentConfigs", () => {
  const configs = gatewayAgentConfigs("https://hub.example/api");
  const byAgent = Object.fromEntries(
    configs.map((config) => [config.agent, config]),
  );

  it("writes the Codex provider Codex actually sends Responses through", () => {
    expect(byAgent.codex).toMatchObject({
      path: "~/.codex/config.toml",
      protocol: "OpenAI Responses",
    });
    expect(byAgent.codex?.source).toContain('model_provider = "hub-william"');
    expect(byAgent.codex?.source).toContain("[model_providers.hub-william]");
    expect(byAgent.codex?.source).toContain(
      'base_url = "https://hub.example/api/gateway/openai/v1"',
    );
    expect(byAgent.codex?.source).toContain(
      `experimental_bearer_token = "${GATEWAY_KEY_PLACEHOLDER}"`,
    );
    expect(byAgent.codex?.source).toContain('wire_api = "responses"');
  });

  it("stops the Claude base URL before /v1 so the CLI can append it", () => {
    expect(byAgent.claude?.path).toBe("~/.claude/settings.json");
    expect(JSON.parse(byAgent.claude?.source ?? "{}")).toEqual({
      env: {
        ANTHROPIC_AUTH_TOKEN: GATEWAY_KEY_PLACEHOLDER,
        ANTHROPIC_BASE_URL: "https://hub.example/api/gateway/claude",
      },
    });
  });

  it("points Grok at the OpenAI-compatible gateway", () => {
    expect(byAgent.grok?.path).toBe("~/.grok/config.toml");
    expect(byAgent.grok?.source).toContain(
      'models_base_url = "https://hub.example/api/gateway/grok/v1"',
    );
    expect(byAgent.grok?.source).toContain("[model.grok-build]");
    expect(byAgent.grok?.source).toContain(
      `api_key = "${GATEWAY_KEY_PLACEHOLDER}"`,
    );
  });
});
