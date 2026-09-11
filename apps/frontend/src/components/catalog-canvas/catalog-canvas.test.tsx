import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import CatalogCanvas from "./index";

function renderLibrary() {
  return render(
    <MemoryRouter>
      <CatalogCanvas
        section="library"
        searchPlaceholder="Search collections and files..."
      />
    </MemoryRouter>,
  );
}

function renderTools(initialUrl = "/tools") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <CatalogCanvas
        section="tools"
        searchPlaceholder="Search Documents and MCP..."
      />
    </MemoryRouter>,
  );
}

describe("CatalogCanvas", () => {
  it("renders one flat node per functional collection", () => {
    renderLibrary();

    for (const name of ["EVIDENCES", "GITHUB", "TAGS", "SKILLS", "TEMPLATES"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(name) }),
      ).toBeVisible();
    }

    expect(screen.queryByRole("button", { name: /HARNESS/ })).toBeNull();
  });

  it("opens one collection sheet with its files and archive", async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByRole("button", { name: /GITHUB/ }));

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeVisible();
    expect(screen.getByRole("button", { name: /mergeable/i })).toBeVisible();
    const downloadAll = screen.getByRole("link", { name: /download all/i });
    const filesHeading = screen.getByRole("heading", { name: /files \(/i });

    expect(downloadAll).toHaveAttribute("download", "github.zip");
    expect(downloadAll.closest('[data-slot="sheet-header"]')).toBeNull();
    expect(downloadAll.closest("section")).toContainElement(filesHeading);

    const sourceLink = screen.getByRole("link", {
      name: "contributors/default/libraries/harness/github/gh-cli.md",
    });

    expect(sourceLink).toHaveAttribute(
      "href",
      `${window.location.origin}/catalog/contributors/default/libraries/harness/github/gh-cli.md`,
    );
    expect(sourceLink).toHaveAttribute("target", "_blank");
    expect(sourceLink).toHaveAttribute("rel", "noreferrer");
  });

  it("searches the files inside a collection without rendering file nodes", async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.type(
      screen.getByRole("searchbox", { name: "Search the catalogue" }),
      "mergeable",
    );

    expect(screen.getByRole("button", { name: /GITHUB/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /EVIDENCES/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /TAGS/ })).toBeNull();
  });

  it("shows Codex, Claude, and Grok config on the gateway tool sheet", () => {
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
    expect(screen.getByText(/\[model\.grok-build\]/)).toBeVisible();
    expect(
      screen.getByText(/python3 - --url=.* --key=YOUR_GATEWAY_KEY/),
    ).toBeVisible();
  });
});
