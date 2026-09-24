import { describe, expect, it } from "vitest";

import { GATEWAY_KEY_PLACEHOLDER } from "./utils.gateway-config";
import { openCodeInstallCommand } from "./utils.opencode-config";

describe("openCodeInstallCommand", () => {
  it("pipes the installer into Python without placing the key in shell history", () => {
    expect(
      openCodeInstallCommand({
        gatewayOrigin: "https://api.hub.example",
        installerUrl: "https://hub.example/opencode.py",
      }),
    ).toBe(
      "curl -fsSL https://hub.example/opencode.py | python3 - --url=https://api.hub.example",
    );
  });

  it("offers an explicit key argument for an existing key", () => {
    expect(
      openCodeInstallCommand({
        gatewayOrigin: "https://api.hub.example",
        installerUrl: "https://hub.example/opencode.py",
        includeKey: true,
      }),
    ).toBe(
      `curl -fsSL https://hub.example/opencode.py | python3 - --url=https://api.hub.example --key=${GATEWAY_KEY_PLACEHOLDER}`,
    );
  });
});
