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
});
