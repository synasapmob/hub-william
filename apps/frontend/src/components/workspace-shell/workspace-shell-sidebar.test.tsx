import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import organizationsService from "@/services/organizations";
import createQueryClient from "@/utils/utils.query-client";

import WorkspaceShellSessionContext from "./workspace-shell-session-context";
import WorkspaceShellSidebar from "./workspace-shell-sidebar";

afterEach(() => vi.restoreAllMocks());

describe("Organization navigation", () => {
  it("keeps only Overview available when the user has no organization", async () => {
    vi.spyOn(organizationsService, "list").mockResolvedValue([]);
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceShellSessionContext.Provider
          value={{
            openAuth: vi.fn(),
            signOut: vi.fn(),
            status: "authenticated",
            user: {
              id: "11111111-1111-4111-8111-111111111111",
              recoveryEmail: null,
              username: "minh",
            },
          }}
        >
          <MemoryRouter>
            <WorkspaceShellSidebar />
          </MemoryRouter>
        </WorkspaceShellSessionContext.Provider>
      </QueryClientProvider>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Organization",
    });
    expect(
      within(navigation).getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("href", "/organization");
    await waitFor(() =>
      expect(
        queryClient.getQueryData([
          ...organizationsService.queryKey,
          "11111111-1111-4111-8111-111111111111",
        ]),
      ).toEqual([]),
    );
    for (const name of ["Agents", "Members", "Usage"]) {
      expect(within(navigation).getByRole("button", { name })).toBeDisabled();
      expect(within(navigation).queryByRole("link", { name })).toBeNull();
    }

    queryClient.setQueryData(
      [
        ...organizationsService.queryKey,
        "11111111-1111-4111-8111-111111111111",
      ],
      [
        {
          createdAt: "2026-09-24T00:00:00Z",
          description: null,
          id: "22222222-2222-4222-8222-222222222222",
          name: "Team Mây",
          role: "owner",
        },
      ],
    );
    await waitFor(() =>
      expect(
        within(navigation).getByRole("link", { name: "Agents" }),
      ).toBeVisible(),
    );
    expect(
      within(navigation).getByRole("link", { name: "Members" }),
    ).toBeVisible();
    expect(
      within(navigation).getByRole("link", { name: "Usage" }),
    ).toBeVisible();
  });
});
