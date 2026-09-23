import { describe, expect, it } from "vitest";

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
});
