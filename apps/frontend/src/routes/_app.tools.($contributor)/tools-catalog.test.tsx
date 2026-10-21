import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import ToolsCatalog from "./tools-catalog";

function renderTools(initialUrl = "/tools", contributor: string | null = null) {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <ToolsCatalog contributor={contributor} />
    </MemoryRouter>,
  );
}

describe("ToolsCatalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("renders one flat node per functional collection", () => {
    renderTools();

    for (const name of [
      "GATEWAY",
      "OPENCODE",
      "OMP",
      "DOWNLOAD REEL",
      "AUDIO TO TEXT",
    ]) {
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
    const downloadAll = screen.getByRole("link", { name: "Download all" });
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

  it("saves a file only from the download text beside its path", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:gateway-md");
    const clicked: HTMLAnchorElement[] = [];

    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    renderTools();

    await user.click(screen.getByRole("button", { name: /GATEWAY/ }));
    await user.click(
      screen.getByRole("link", {
        name: "contributors/default/tools/gateway/gateway.md",
      }),
    );

    expect(createObjectURL).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "(click here to download)" }),
    );

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicked.at(-1)).toHaveAttribute("download", "gateway.md");
    expect(clicked.at(-1)).toHaveAttribute("href", "blob:gateway-md");
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
    // One suggested command, with the key passed explicitly.
    expect(screen.getAllByText(/opencode\.py.*--url=/)).toHaveLength(1);
    expect(
      screen.getByText(/opencode\.py.*--url=.*--key=YOUR_GATEWAY_KEY/),
    ).toBeVisible();
    expect(screen.getByText("Pass a key explicitly")).toBeVisible();
    expect(
      screen.queryByText("Install all live providers"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("/models", { exact: true })).not.toHaveLength(0);
    expect(screen.getByText("/variants", { exact: true })).toBeVisible();
  });

  it("shows the OMP installer and native model picker", () => {
    renderTools("/tools?node=omp");

    expect(screen.getByRole("heading", { name: "OMP" })).toBeVisible();
    // One suggested command, with the key passed explicitly.
    expect(screen.getAllByText(/omp\.py.*--url=/)).toHaveLength(1);
    expect(
      screen.getByText(/omp\.py.*--url=.*--key=YOUR_GATEWAY_KEY/),
    ).toBeVisible();
    expect(screen.getByText("Pass a key explicitly")).toBeVisible();
    expect(
      screen.queryByText("Install all live providers"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("/model", { exact: true })).toBeVisible();
  });

  it("finds DOWNLOAD REEL and copies a curl command with platform and URL options", async () => {
    const user = userEvent.setup();
    renderTools();

    await user.type(
      screen.getByRole("searchbox", { name: "Search the catalogue" }),
      "tiktok",
    );
    await user.click(screen.getByRole("button", { name: /DOWNLOAD REEL/ }));

    expect(
      screen.getByRole("heading", { name: "How to use via API" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        `curl -fsSL ${window.location.origin}/download-reel.sh | bash -s -- --platform=tiktok --url='REEL_URL'`,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Download Reel" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(
      `curl -fsSL ${window.location.origin}/download-reel.sh | bash -s -- --platform=tiktok --url='REEL_URL'`,
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("lists a contributor's skills and link script as two plain cards", () => {
    renderTools("/tools/synasapmob", "synasapmob");

    expect(screen.getByRole("heading", { name: "SKILLS" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "LINK SKILLS" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("keeps every skill in one sheet with a single download", () => {
    renderTools("/tools/synasapmob?node=skills", "synasapmob");

    expect(screen.getByRole("heading", { name: "Skills" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: /^Files \(\d+\)$/ }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Download all" })).toHaveAttribute(
      "href",
      `${window.location.origin}/catalog/collections/synasapmob/tools/skills.zip`,
    );
    for (const skill of [
      "frontend-convention",
      "mock-data",
      "operator-cli",
      "scroll-world",
    ]) {
      expect(
        screen.getByRole("link", {
          name: `contributors/synasapmob/tools/skills/${skill}/SKILL.md`,
        }),
      ).toBeVisible();
    }
    expect(
      screen.getByRole("heading", { name: "How to install" }),
    ).toBeVisible();
  });

  it("offers link.sh from Hub William or from your own copy", () => {
    renderTools("/tools/synasapmob?node=link-skills", "synasapmob");

    const linkCommand = `curl -fsSL ${window.location.origin}/catalog/contributors/synasapmob/tools/link-skills/link.sh | bash`;

    expect(screen.getByRole("heading", { name: "Link skills" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Files (2)" })).toBeVisible();
    expect(screen.getByText("1. From Hub William")).toBeVisible();
    expect(screen.getByText(linkCommand)).toBeVisible();
    expect(screen.getByText("2. From your own copy")).toBeVisible();
    expect(
      screen.getByText(`${linkCommand} -s -- --path=~/Downloads/skills.zip`),
    ).toBeVisible();
    for (const script of ["link.sh", "unlink.sh"]) {
      expect(
        screen.getByRole("link", {
          name: `contributors/synasapmob/tools/link-skills/${script}`,
        }),
      ).toBeVisible();
    }
    expect(screen.getByRole("link", { name: "Download all" })).toHaveAttribute(
      "href",
      `${window.location.origin}/catalog/collections/synasapmob/tools/link-skills.zip`,
    );
  });
});
