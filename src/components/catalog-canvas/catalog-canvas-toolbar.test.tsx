import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CatalogCanvasToolbar from "./catalog-canvas-toolbar";

describe("CatalogCanvasToolbar", () => {
  it("filters the open tree from a group chip, and All clears the filter", async () => {
    const user = userEvent.setup();
    const onSelectGroup = vi.fn();

    const { rerender } = render(
      <CatalogCanvasToolbar
        documentCount={26}
        expandedCategory="harness"
        groupCount={5}
        groups={["evidence", "github", "tags"]}
        roots={["harness", "skills", "templates"]}
        searchPlaceholder="Search"
        searchQuery=""
        selectedGroup={null}
        onSearchQueryChange={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectGroup={onSelectGroup}
      />,
    );

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Evidence" }));

    expect(onSelectGroup).toHaveBeenCalledWith("evidence");

    rerender(
      <CatalogCanvasToolbar
        documentCount={26}
        expandedCategory="harness"
        groupCount={5}
        groups={["evidence", "github", "tags"]}
        roots={["harness", "skills", "templates"]}
        searchPlaceholder="Search"
        searchQuery=""
        selectedGroup="evidence"
        onSearchQueryChange={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectGroup={onSelectGroup}
      />,
    );

    expect(screen.getByRole("button", { name: "Evidence" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(onSelectGroup).toHaveBeenCalledWith(null);
  });
});
