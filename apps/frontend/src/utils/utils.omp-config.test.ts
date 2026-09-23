import { describe, expect, it } from "vitest";

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
});
