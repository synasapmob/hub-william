import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSessionContext from "@/components/workspace-shell/workspace-shell-session-context";
import agentConnectionsService, {
  type AgentConnection,
} from "@/services/agent-connections";
import organizationsService, {
  type OrganizationAgentDetails,
} from "@/services/organizations";
import createQueryClient from "@/utils/utils.query-client";

import OrganizationAgentsRoute from "./route";
import OrganizationAgentsExplorer from "./organization-agents-explorer";

const organization = {
  createdAt: "2026-09-23T00:00:00Z",
  description: null,
  id: "11111111-1111-4111-8111-111111111111",
  name: "Team Mây",
  role: "member" as const,
};
const connection: AgentConnection = {
  accountLabel: "••••1234",
  authorization: null,
  availabilityStatus: "active",
  createdAt: "2026-09-23T00:00:00Z",
  failureMessage: null,
  id: "22222222-2222-4222-8222-222222222222",
  plan: "API",
  provider: "deepseek",
  status: "connected",
  updatedAt: "2026-09-23T00:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("Organization Agents", () => {
  it.each([
    ["chatgpt", "ChatGPT"],
    ["claude", "Claude"],
    ["gemini", "Gemini / AGY"],
    ["grok", "Grok"],
    ["deepseek", "DeepSeek"],
  ] as const)(
    "shares an existing %s account with its real status without reauthorization",
    async (provider, label) => {
      const existing: AgentConnection = {
        ...connection,
        provider,
        availabilityStatus: "reauth_required",
      };
      const start = vi.spyOn(agentConnectionsService, "start");
      const refresh = vi.spyOn(agentConnectionsService, "refresh");
      const complete = vi.spyOn(agentConnectionsService, "complete");
      const popup = vi.spyOn(window, "open");
      vi.spyOn(agentConnectionsService, "list").mockResolvedValue([existing]);
      vi.spyOn(organizationsService, "agents").mockResolvedValue([]);
      const addAgent = vi
        .spyOn(organizationsService, "addAgent")
        .mockResolvedValue({
          accountLabel: existing.accountLabel,
          availabilityStatus: existing.availabilityStatus,
          createdAt: existing.createdAt,
          id: existing.id,
          ownerUsername: "minh",
          provider: existing.provider,
          rateLimitedUntil: null,
        });

      render(
        <QueryClientProvider client={createQueryClient()}>
          <WorkspaceShellSessionContext.Provider
            value={{
              user: {
                id: "33333333-3333-4333-8333-333333333333",
                username: "minh",
                recoveryEmail: null,
              },
              status: "authenticated",
              openAuth: vi.fn(),
              signOut: vi.fn(),
            }}
          >
            <MemoryRouter initialEntries={["/organization/agents"]}>
              <Routes>
                <Route
                  path="/organization"
                  element={<Outlet context={{ organization }} />}
                >
                  <Route path="agents" element={<OrganizationAgentsRoute />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </WorkspaceShellSessionContext.Provider>
        </QueryClientProvider>,
      );

      const providers = await screen.findByRole("navigation", {
        name: "Agent providers",
      });
      expect(
        within(providers).getByRole("button", { name: "ChatGPT, 0 accounts" }),
      ).toBeVisible();
      expect(
        within(providers).getByRole("button", { name: "DeepSeek, 0 accounts" }),
      ).toBeVisible();
      expect(
        screen.getByRole("textbox", { name: "Search accounts" }),
      ).toBeVisible();
      expect(screen.queryByText("No agents yet")).not.toBeInTheDocument();
      expect(screen.queryByText("Add my agent")).not.toBeInTheDocument();
      expect(screen.queryByText(/No accounts match/)).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Connect Agent" }));
      expect(screen.getByText("Share a connected agent")).toBeVisible();
      expect(await screen.findByText("Reconnect required")).toBeVisible();
      expect(screen.getByText(/without signing in again/)).toBeVisible();
      await user.click(
        screen.getByRole("button", {
          name: `Add ${label} ••••1234 to organization`,
        }),
      );
      await waitFor(() =>
        expect(addAgent).toHaveBeenCalledWith(organization.id, existing.id),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(start).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(popup).not.toHaveBeenCalled();
    },
  );

  it("lets a member connect an agent and immediately shares it with the organization", async () => {
    let shared: OrganizationAgentDetails[] = [];
    vi.spyOn(agentConnectionsService, "list").mockResolvedValue([]);
    vi.spyOn(agentConnectionsService, "connectDeepseek").mockResolvedValue(
      connection,
    );
    vi.spyOn(organizationsService, "agents").mockImplementation(
      async () => shared,
    );
    vi.spyOn(organizationsService, "usage").mockResolvedValue({
      breakdown: [],
      dailyUsage: [],
      knownCachedTokens: 0,
      knownInputTokens: 100,
      knownOutputTokens: 50,
      periodDays: 30,
      requests: 2,
      tokenKnownRequests: 2,
    });
    const addAgent = vi
      .spyOn(organizationsService, "addAgent")
      .mockImplementation(async () => {
        const agent: OrganizationAgentDetails = {
          accountLabel: connection.accountLabel,
          availabilityStatus: "active",
          createdAt: connection.createdAt,
          id: connection.id,
          ownerUsername: "minh",
          plan: "API",
          provider: connection.provider,
          rateLimitedUntil: null,
          usage: [],
        };
        shared = [agent];
        return agent;
      });

    render(
      <QueryClientProvider client={createQueryClient()}>
        <WorkspaceShellSessionContext.Provider
          value={{
            user: {
              id: "33333333-3333-4333-8333-333333333333",
              username: "minh",
              recoveryEmail: null,
            },
            status: "authenticated",
            openAuth: vi.fn(),
            signOut: vi.fn(),
          }}
        >
          <MemoryRouter initialEntries={["/organization/agents"]}>
            <Routes>
              <Route
                path="/organization"
                element={<Outlet context={{ organization }} />}
              >
                <Route path="agents" element={<OrganizationAgentsRoute />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </WorkspaceShellSessionContext.Provider>
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Connect Agent" }));
    await user.click(screen.getByRole("button", { name: /deepseek/i }));
    await user.type(
      screen.getByLabelText("DeepSeek API key"),
      "sk-deepseek-secret-1234",
    );
    await user.click(screen.getByRole("button", { name: "Connect DeepSeek" }));

    await waitFor(() =>
      expect(addAgent).toHaveBeenCalledWith(organization.id, connection.id),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Open DeepSeek account ••••1234",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Remove from organization" }),
    ).toBeVisible();
    expect(screen.getByText("Organization usage · last 30 days")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Account usage" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(screen.queryByText("Request Join")).not.toBeInTheDocument();
    expect(screen.queryByText("Use in Playground")).not.toBeInTheDocument();
  });

  it("shows provider quota for a supported account and hides empty organization activity", async () => {
    vi.spyOn(organizationsService, "usage").mockResolvedValue({
      breakdown: [],
      dailyUsage: [],
      knownCachedTokens: 0,
      knownInputTokens: 0,
      knownOutputTokens: 0,
      periodDays: 30,
      requests: 0,
      tokenKnownRequests: 0,
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <OrganizationAgentsExplorer
          agents={[
            {
              accountLabel: "Claude account",
              availabilityStatus: "active",
              createdAt: "2026-09-23T00:00:00Z",
              id: connection.id,
              ownerUsername: "other",
              plan: "Pro",
              provider: "claude",
              rateLimitedUntil: null,
              usage: [{ label: "5-hour limit", value: "70% remaining" }],
            },
          ]}
          currentUsername="minh"
          isOrganizationOwner={true}
          onRemove={vi.fn()}
          organizationId={organization.id}
          removeError={null}
          removeErrorId={null}
          removing={false}
        />
      </QueryClientProvider>,
    );

    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Open Claude account Claude account",
      }),
    );
    const quota = screen.getByRole("region", { name: "Account usage" });
    expect(quota).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Remove from organization" }),
    ).toBeVisible();
    expect(within(quota).getByText("70% remaining")).toBeVisible();
    await waitFor(() => expect(organizationsService.usage).toHaveBeenCalled());
    expect(
      screen.queryByText("Organization usage · last 30 days"),
    ).not.toBeInTheDocument();
  });

  it("reports an organization activity load failure and lets the member retry", async () => {
    const usage = vi.spyOn(organizationsService, "usage");
    usage.mockRejectedValueOnce(new Error("Activity service unavailable"));
    usage.mockResolvedValue({
      breakdown: [],
      dailyUsage: [],
      knownCachedTokens: 0,
      knownInputTokens: 10,
      knownOutputTokens: 5,
      periodDays: 30,
      requests: 1,
      tokenKnownRequests: 1,
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <OrganizationAgentsExplorer
          agents={[
            {
              accountLabel: "DeepSeek account",
              availabilityStatus: "active",
              createdAt: "2026-09-23T00:00:00Z",
              id: connection.id,
              ownerUsername: "minh",
              plan: "API",
              provider: "deepseek",
              rateLimitedUntil: null,
              usage: [],
            },
          ]}
          currentUsername="minh"
          isOrganizationOwner={false}
          onRemove={vi.fn()}
          organizationId={organization.id}
          removeError={null}
          removeErrorId={null}
          removing={false}
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Open DeepSeek account DeepSeek account",
      }),
    );
    expect(
      await screen.findByText(/Organization activity could not be loaded/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry activity" }));
    expect(
      await screen.findByText("Organization usage · last 30 days"),
    ).toBeVisible();
    expect(usage).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(/Organization activity could not be loaded/),
    ).not.toBeInTheDocument();
  });
});
