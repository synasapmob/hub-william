import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import WorkspaceShellRecentUpdates from "./workspace-shell-recent-updates";

describe("WorkspaceShellRecentUpdates", () => {
  it("links every fixture to a current catalogue entry", () => {
    render(
      <MemoryRouter>
        <WorkspaceShellRecentUpdates />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("region", { name: "Recent catalogue updates" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.getByRole("link", { name: /report tags/i })).toHaveAttribute(
      "href",
      "/library?node=tags",
    );
  });
});
