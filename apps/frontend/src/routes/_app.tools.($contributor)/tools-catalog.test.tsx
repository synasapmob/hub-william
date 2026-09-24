import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import ToolsCatalog from "./tools-catalog";

function renderTools(initialUrl = "/tools") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <ToolsCatalog />
    </MemoryRouter>,
  );
}

describe("ToolsCatalog", () => {
  it("renders one flat node per functional collection", () => {
    renderTools();

    for (const name of ["GATEWAY", "OPENCODE", "OMP"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(name) }),
      ).toBeVisible();
    }

    expect(
      screen.queryByRole("button", { name: /DOCUMENTS|MCP|LIBRARIES|HARNESS/ }),
    ).toBeNull();
  });

  it("opens one collection sheet with its files and archive", async () => {
    const user = userEvent.setup();
    renderTools();

    await user.click(screen.getByRole("button", { name: /GATEWAY/ }));

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Gateway" })).toBeVisible();
    const downloadAll = screen.getByRole("link", { name: /download all/i });
    const filesHeading = screen.getByRole("heading", { name: /files \(/i });

    expect(downloadAll).toHaveAttribute("download", "gateway.zip");
    expect(downloadAll.closest('[data-slot="sheet-header"]')).toBeNull();
    expect(downloadAll.closest("section")).toContainElement(filesHeading);

    const sourceLink = screen.getByRole("link", {
      name: "contributors/default/tools/gateway/gateway.md",
    });

    expect(sourceLink).toHaveAttribute(
      "href",
      `${window.location.origin}/catalog/contributors/default/tools/gateway/gateway.md`,
    );
    expect(sourceLink).toHaveAttribute("target", "_blank");
    expect(sourceLink).toHaveAttribute("rel", "noreferrer");
  });

  it("searches the files inside a collection without rendering file nodes", async () => {
    const user = userEvent.setup();
    renderTools();

    await user.type(
      screen.getByRole("searchbox", { name: "Search the catalogue" }),
      "opencode.md",
    );

    expect(screen.getByRole("button", { name: /OPENCODE/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /GATEWAY/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /OMP/ })).toBeNull();
  });

  it("shows Codex, Claude, AGY, and Grok config on the gateway tool sheet", () => {
    renderTools("/tools?node=gateway");

    expect(screen.getByRole("heading", { name: "Gateway" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "How to install and use" }),
    ).toBeVisible();
    expect(
      screen.getByText("~/.codex/config.toml", { exact: false }),
    ).toBeVisible();
    expect(screen.getByText(/model_provider = "hub-william"/)).toBeVisible();
    expect(screen.getByText(/experimental_bearer_token/)).toBeVisible();
    expect(screen.getByText(/ANTHROPIC_BASE_URL/)).toBeVisible();
    expect(screen.getByText(/GOOGLE_GEMINI_BASE_URL/)).toBeVisible();
    expect(screen.getByText(/GEMINI_API_KEY/)).toBeVisible();
    expect(screen.getByText(/\[model\.grok-build\]/)).toBeVisible();
    expect(screen.getByText(/python3 - --url=/)).toBeVisible();
    expect(screen.getByText(/Hub key in a hidden prompt/)).toBeVisible();
  });

  it("shows the OpenCode installer and native model controls", () => {
    renderTools("/tools?node=opencode");

    expect(screen.getByRole("heading", { name: "OpenCode" })).toBeVisible();
    expect(screen.getAllByText(/opencode\.py.*--url=/)).toHaveLength(2);
    expect(
      screen.getByText(/opencode\.py.*--key=YOUR_GATEWAY_KEY/),
    ).toBeVisible();
    expect(screen.getAllByText("/models", { exact: true })).not.toHaveLength(0);
    expect(screen.getByText("/variants", { exact: true })).toBeVisible();
  });

  it("shows the OMP installer and native model picker", () => {
    renderTools("/tools?node=omp");

    expect(screen.getByRole("heading", { name: "OMP" })).toBeVisible();
    expect(screen.getAllByText(/omp\.py.*--url=/)).toHaveLength(2);
    expect(screen.getByText(/omp\.py.*--key=YOUR_GATEWAY_KEY/)).toBeVisible();
    expect(screen.getByText("models.yml", { exact: true })).toBeVisible();
    expect(screen.getByText("/model", { exact: true })).toBeVisible();
  });
});
