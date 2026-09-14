import { describe, expect, it } from "vitest";

import { openCodeInstallCommand } from "./utils.opencode-config";

describe("openCodeInstallCommand", () => {
  it("pipes the installer into Python with the Hub origin and key", () => {
    expect(
      openCodeInstallCommand({
        gatewayOrigin: "https://api.hub.example",
        installerUrl: "https://hub.example/opencode.py",
      }),
    ).toBe(
      "curl -fsSL https://hub.example/opencode.py | python3 - --url=https://api.hub.example --key=YOUR_GATEWAY_KEY",
    );
  });
});
