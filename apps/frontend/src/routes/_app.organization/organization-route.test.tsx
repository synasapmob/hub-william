import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import authService from "@/services/auth";
import organizationsService, {
  type Organization,
  type OrganizationMember,
  type OrganizationOverview,
} from "@/services/organizations";
import createQueryClient from "@/utils/utils.query-client";

import OrganizationOverviewRoute from "@/routes/_app.organization._index/route";
import OrganizationUsageRoute from "@/routes/_app.organization.usage/route";

import OrganizationRoute from "./route";

const first: Organization = {
  createdAt: "2026-09-20T00:00:00Z",
  description: null,
  id: "11111111-1111-4111-8111-111111111111",
  name: "Team Mây",
  role: "owner",
};
const second: Organization = {
  createdAt: "2026-09-21T00:00:00Z",
  description: null,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Team Nắng",
  role: "member",
};

function overviewFor(organization: Organization): OrganizationOverview {
  return {
    agentCount: organization.id === first.id ? 3 : 1,
    agents: [],
    dailyUsage: [],
    knownCachedTokens: 0,
    knownInputTokens: 900,
    knownOutputTokens: 100,
    memberCount: organization.id === first.id ? 5 : 2,
    organization,
    periodDays: 30,
    requests: organization.id === first.id ? 12 : 2,
    tokenKnownRequests: organization.id === first.id ? 8 : 1,
  };
}

function RouteLocation() {
  const location = useLocation();
  return <output>Current route: {location.pathname}</output>;
}

function renderRoute(initialEntry = "/organization") {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceShellSession>
        <MemoryRouter initialEntries={[initialEntry]}>
          <RouteLocation />
          <Routes>
            <Route path="/organization" element={<OrganizationRoute />}>
              <Route index element={<OrganizationOverviewRoute />} />
              <Route path="usage" element={<OrganizationUsageRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </WorkspaceShellSession>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage?.clear();
});

describe("Organization overview", () => {
  it("returns direct subpage visits to Overview when no organization exists", async () => {
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list").mockResolvedValue([]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);

    renderRoute("/organization/usage");

    expect(
      await screen.findByRole("heading", { name: "Create an organization" }),
    ).toBeVisible();
    expect(screen.getByText("Current route: /organization")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Organization name" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Description (optional)" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Usage" })).toBeNull();
  });

  it("switches the selected organization and shows only its real aggregate", async () => {
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list").mockResolvedValue([first, second]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    const overview = vi
      .spyOn(organizationsService, "overview")
      .mockImplementation(async (id) =>
        overviewFor(id === first.id ? first : second),
      );

    renderRoute();

    expect(
      await screen.findByRole("heading", { name: "Overview" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Selected organization" }),
    ).toHaveTextContent("Team Mây");
    expect(
      await screen.findByText("Reported by 8 of 12 requests"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "Selected organization" }),
    );
    await user.click(screen.getByRole("option", { name: "Team Nắng" }));

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Selected organization" }),
      ).toHaveTextContent("Team Nắng"),
    );
    expect(screen.getByText("Reported by 1 of 2 requests")).toBeInTheDocument();
    expect(overview).toHaveBeenCalledWith(second.id, 30);
  });

  it("opens New organization in a dialog and selects the created team", async () => {
    const created: Organization = {
      createdAt: "2026-09-24T00:00:00Z",
      description: null,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Team Sông",
      role: "owner",
    };
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list")
      .mockResolvedValueOnce([first])
      .mockResolvedValue([first, created]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    vi.spyOn(organizationsService, "overview").mockImplementation(async (id) =>
      overviewFor(id === created.id ? created : first),
    );
    const create = vi
      .spyOn(organizationsService, "create")
      .mockResolvedValue(created);

    renderRoute();
    await screen.findByRole("heading", { name: "Overview" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New organization" }));
    const dialog = screen.getByRole("dialog", {
      name: "Create an organization",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Organization name" }),
      "Team Sông",
    );
    const description = within(dialog).getByRole("textbox", {
      name: "Description (optional)",
    });
    fireEvent.change(description, { target: { value: "x".repeat(351) } });
    await user.click(
      within(dialog).getByRole("button", { name: "Create organization" }),
    );
    expect(
      within(dialog).getByText("Use 350 characters or fewer."),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();

    const emojiDescription = "😀".repeat(200);
    fireEvent.change(description, { target: { value: emojiDescription } });
    expect(within(dialog).getByText("200/350")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Create organization" }),
    );

    await waitFor(() =>
      expect(create.mock.calls[0]?.[0]).toEqual({
        description: emojiDescription,
        name: "Team Sông",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Selected organization" }),
      ).toHaveTextContent("Team Sông"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Organization usage", () => {
  it("keeps a member link filtered while the member list is loading", async () => {
    const memberId = "44444444-4444-4444-8444-444444444444";
    let resolveMembers!: (members: OrganizationMember[]) => void;
    const membersPending = new Promise<OrganizationMember[]>((resolve) => {
      resolveMembers = resolve;
    });
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list").mockResolvedValue([first]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    vi.spyOn(organizationsService, "members").mockReturnValue(membersPending);
    vi.spyOn(organizationsService, "agents").mockResolvedValue([]);
    const usage = vi
      .spyOn(organizationsService, "usage")
      .mockImplementation(async (_id, filters) => ({
        breakdown: [],
        dailyUsage: [],
        knownCachedTokens: 0,
        knownInputTokens: 0,
        knownOutputTokens: 0,
        periodDays: filters.days,
        requests: filters.memberId ? 1 : 9,
        tokenKnownRequests: 0,
      }));

    renderRoute(`/organization/usage?member=${memberId}`);

    await waitFor(() =>
      expect(usage).toHaveBeenCalledWith(first.id, {
        days: 30,
        memberId,
        connectionId: undefined,
        model: undefined,
      }),
    );
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("heading", { name: "Requests" }).parentElement!,
        ).getByText("1"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("combobox", { name: "Member" })).toHaveTextContent(
      "Loading member…",
    );

    resolveMembers([
      {
        id: memberId,
        invitedAt: "2026-09-20T00:00:00Z",
        invitedByUsername: "ban",
        joinedAt: "2026-09-21T00:00:00Z",
        role: "member",
        status: "accepted",
        username: "minh",
      },
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Member" }),
      ).toHaveTextContent("@minh"),
    );
  });
});
