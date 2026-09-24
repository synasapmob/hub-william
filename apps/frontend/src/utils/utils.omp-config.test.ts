import { describe, expect, it } from "vitest";

import { GATEWAY_KEY_PLACEHOLDER } from "./utils.gateway-config";
import { ompInstallCommand } from "./utils.omp-config";

describe("ompInstallCommand", () => {
  it("pipes the installer into Python without placing the key in shell history", () => {
    expect(
      ompInstallCommand({
        gatewayOrigin: "https://api.hub.example",
        installerUrl: "https://hub.example/omp.py",
      }),
    ).toBe(
      "curl -fsSL https://hub.example/omp.py | python3 - --url=https://api.hub.example",
    );
  });

  it("offers an explicit key argument for an existing key", () => {
    expect(
      ompInstallCommand({
        gatewayOrigin: "https://api.hub.example",
        installerUrl: "https://hub.example/omp.py",
        includeKey: true,
      }),
    ).toBe(
      `curl -fsSL https://hub.example/omp.py | python3 - --url=https://api.hub.example --key=${GATEWAY_KEY_PLACEHOLDER}`,
    );
  });
});
