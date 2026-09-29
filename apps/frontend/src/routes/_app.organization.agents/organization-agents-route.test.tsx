import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const linkedAgent: OrganizationAgentDetails = {
  accountLabel: "••••1234",
  availabilityStatus: "active",
  createdAt: "2026-09-23T00:00:00Z",
  id: connection.id,
  ownerUsername: "minh",
  plan: "API",
  provider: "deepseek",
  rateLimitedUntil: null,
  usage: [],
};

const emptyUsage = {
  breakdown: [],
  dailyUsage: [],
  knownCachedTokens: 0,
  knownInputTokens: 0,
  knownOutputTokens: 0,
  periodDays: 30,
  requests: 0,
  tokenKnownRequests: 0,
};

// Views of the same Workspace account that must not keep stale data after it
// is refreshed or unlinked from the organization.
const linkedViews = [
  ["agent-pools", "33333333-3333-4333-8333-333333333333"],
  ["agent-connections", "33333333-3333-4333-8333-333333333333"],
  ["organizations", "33333333-3333-4333-8333-333333333333"],
  ["organizations", organization.id, "agents"],
  [
    "playground",
    "models",
    "33333333-3333-4333-8333-333333333333",
    "deepseek",
    connection.id,
    organization.id,
  ],
];

interface RenderOrganizationAgentsOptions {
  queryClient?: QueryClient;
  username?: string;
}

function renderOrganizationAgents({
  queryClient = createQueryClient(),
  username = "minh",
}: RenderOrganizationAgentsOptions = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceShellSessionContext.Provider
        value={{
          user: {
            id: "33333333-3333-4333-8333-333333333333",
            username,
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
  return queryClient;
}

function apiConnection(values: Record<string, unknown> = {}) {
  return {
    account_label: connection.accountLabel,
    authorization: null,
    availability_status: "active",
    created_at: connection.createdAt,
    failure_message: null,
    id: connection.id,
    plan: connection.plan,
    provider: connection.provider,
    status: "connected",
    updated_at: connection.updatedAt,
    ...values,
  };
}

function mockPopup() {
  const popup = {
    close: vi.fn(),
    location: { replace: vi.fn() },
    opener: window as Window | null,
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return popup;
}

describe("Organization Agents", () => {
  it("shows the provider layout with zero counts when no agents are shared", async () => {
    const secondConnection: AgentConnection = {
      ...connection,
      id: "44444444-4444-4444-8444-444444444444",
      provider: "chatgpt",
      accountLabel: "mi***@example.com",
    };
    const connections = [connection, secondConnection];
    const shared: OrganizationAgentDetails[] = [];
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    vi.spyOn(agentConnectionsService, "list").mockResolvedValue(connections);
    vi.spyOn(organizationsService, "agents").mockImplementation(async () => [
      ...shared,
    ]);
    const addAgent = vi
      .spyOn(organizationsService, "addAgent")
      .mockImplementation(async (_organizationId, connectionId) => {
        const selected = connections.find((item) => item.id === connectionId)!;
        const agent: OrganizationAgentDetails = {
          accountLabel: selected.accountLabel,
          availabilityStatus: "active",
          createdAt: selected.createdAt,
          id: selected.id,
          ownerUsername: "minh",
          provider: selected.provider,
          rateLimitedUntil: null,
          plan: "Test subscription",
          usage: [],
        };
        shared.push(agent);
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
    const filter = screen.getByRole("combobox", {
      name: "Filter connected agents by provider",
    });
    expect(filter).toHaveTextContent("ChatGPT");
    expect(
      screen.queryByRole("button", {
        name: "Add DeepSeek ••••1234 to organization",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Add ChatGPT mi***@example.com to organization",
      }),
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "mi***@example.com shared with the organization.",
      ),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(
      screen.getByText("All your ChatGPT accounts are already shared."),
    ).toBeVisible();
    await user.click(filter);
    await user.click(screen.getByRole("option", { name: "DeepSeek" }));
    await user.click(
      screen.getByRole("button", {
        name: "Add DeepSeek ••••1234 to organization",
      }),
    );
    await waitFor(() =>
      expect(addAgent).toHaveBeenCalledWith(organization.id, connection.id),
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "••••1234 shared with the organization.",
      ),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(
      screen.getByText("All your DeepSeek accounts are already shared."),
    ).toBeVisible();
    expect(addAgent).toHaveBeenCalledTimes(2);
  });

  it("lets a member connect an agent and immediately shares it with the organization", async () => {
    let shared: OrganizationAgentDetails[] = [];
    vi.spyOn(agentConnectionsService, "list").mockResolvedValue([]);
    vi.spyOn(agentConnectionsService, "connectApiKey").mockResolvedValue(
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
          onRefresh={vi.fn()}
          onRefreshComplete={vi.fn()}
          onRemove={vi.fn()}
          organizationId={organization.id}
          refreshing={false}
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
          onRefresh={vi.fn()}
          onRefreshComplete={vi.fn()}
          onRemove={vi.fn()}
          organizationId={organization.id}
          refreshing={false}
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
  it.each([
    ["chatgpt", "ChatGPT"],
    ["claude", "Claude"],
    ["gemini", "Gemini / AGY"],
    ["grok", "Grok"],
    ["deepseek", "DeepSeek"],
    ["groq", "Groq"],
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
      expect(
        screen.getByText(/gets a link to your Workspace account, not a copy/),
      ).toBeVisible();
      await user.click(
        screen.getByRole("button", {
          name: `Add ${label} ••••1234 to organization`,
        }),
      );
      await waitFor(() =>
        expect(addAgent).toHaveBeenCalledWith(organization.id, existing.id),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(start).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(popup).not.toHaveBeenCalled();
    },
  );

  it("labels each organization agent as a live link to its owner's Workspace", async () => {
    vi.spyOn(organizationsService, "agents").mockResolvedValue([
      { ...linkedAgent, ownerUsername: "lan" },
    ]);
    vi.spyOn(organizationsService, "usage").mockResolvedValue(emptyUsage);
    renderOrganizationAgents();

    const row = await screen.findByRole("button", {
      name: "Open DeepSeek account ••••1234",
    });
    expect(within(row).getByText("Linked from @lan's Workspace")).toBeVisible();
    await userEvent.setup().click(row);
    const detail = screen.getByRole("dialog");
    expect(
      within(detail).getByText("Linked from @lan's Workspace"),
    ).toBeVisible();
    expect(
      within(detail).getByText(
        /Refreshing or reconnecting it in Workspace updates it here, and deleting it in Workspace removes it from this organization\./,
      ),
    ).toBeVisible();
  });

  it("lets the connection owner refresh the linked Workspace credential and updates every view", async () => {
    const popup = mockPopup();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json(apiConnection());
      }),
    );
    vi.spyOn(organizationsService, "agents").mockResolvedValue([
      { ...linkedAgent, availabilityStatus: "reauth_required" },
    ]);
    vi.spyOn(organizationsService, "usage").mockResolvedValue(emptyUsage);
    const queryClient = createQueryClient();
    for (const key of linkedViews) queryClient.setQueryData(key, []);
    const pollingKey = ["agent-connections", "refresh-status", connection.id];
    queryClient.setQueryData(pollingKey, {});
    renderOrganizationAgents({ queryClient });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Open DeepSeek account ••••1234",
      }),
    );
    expect(
      screen.queryByText(/Ask @minh to reconnect it/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText("Provider credential refreshed"),
    ).toBeVisible();
    expect(popup.close).toHaveBeenCalled();
    expect(requests.map((request) => request.method)).toEqual(["POST"]);
    expect(new URL(requests[0].url).pathname).toBe(
      `/agent-connections/${connection.id}/refresh`,
    );
    for (const key of linkedViews) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(pollingKey)?.isInvalidated).toBe(false);
  });

  it("finishes provider reauthorization from the organization when refresh requires it", async () => {
    const popup = mockPopup();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json(
          new URL(request.url).pathname.endsWith("/refresh")
            ? apiConnection({
                authorization: {
                  authorization_url:
                    "https://claude.com/oauth/authorize?refresh=true",
                  expires_at: "2026-09-23T01:00:00Z",
                  poll_after_seconds: 5,
                  requires_callback_url: true,
                  user_code: null,
                },
                availability_status: "reauth_required",
              })
            : apiConnection(),
        );
      }),
    );
    vi.spyOn(organizationsService, "agents").mockResolvedValue([linkedAgent]);
    vi.spyOn(organizationsService, "usage").mockResolvedValue(emptyUsage);
    renderOrganizationAgents();

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Open DeepSeek account ••••1234",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith(
        "https://claude.com/oauth/authorize?refresh=true",
      ),
    );
    expect(popup.opener).toBeNull();
    expect(
      screen.getByText("Waiting for provider authorization"),
    ).toBeVisible();
    await user.type(
      screen.getByLabelText("Callback URL or code"),
      "callback-code#state-token",
    );
    await user.click(
      screen.getByRole("button", { name: "Complete reconnection" }),
    );
    expect(
      await screen.findByText("Provider credential refreshed"),
    ).toBeVisible();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/agent-connections/${connection.id}/refresh`,
      `/agent-connections/${connection.id}/complete`,
    ]);
  });

  it("never offers Refresh to a member who does not own the linked account", async () => {
    const refresh = vi.spyOn(agentConnectionsService, "refresh");
    vi.spyOn(organizationsService, "agents").mockResolvedValue([
      {
        ...linkedAgent,
        availabilityStatus: "reauth_required",
        ownerUsername: "lan",
      },
    ]);
    vi.spyOn(organizationsService, "usage").mockResolvedValue(emptyUsage);
    renderOrganizationAgents();

    await userEvent.setup().click(
      await screen.findByRole("button", {
        name: "Open DeepSeek account ••••1234",
      }),
    );
    expect(
      screen.getByText("Ask @lan to reconnect it in Workspace."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove from organization" }),
    ).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes only the organization link and clears cached Playground data for it", async () => {
    let shared = [linkedAgent];
    vi.spyOn(organizationsService, "agents").mockImplementation(
      async () => shared,
    );
    vi.spyOn(organizationsService, "usage").mockResolvedValue(emptyUsage);
    const disconnect = vi.spyOn(agentConnectionsService, "disconnect");
    const removeAgent = vi
      .spyOn(organizationsService, "removeAgent")
      .mockImplementation(async () => {
        shared = [];
      });
    const queryClient = createQueryClient();
    for (const key of linkedViews) queryClient.setQueryData(key, []);
    renderOrganizationAgents({ queryClient });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Open DeepSeek account ••••1234",
      }),
    );
    expect(
      screen.getByText(
        "Removing it only unlinks it from this organization. The Workspace account stays connected.",
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Remove from organization" }),
    );

    await waitFor(() =>
      expect(removeAgent).toHaveBeenCalledWith(organization.id, connection.id),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Open DeepSeek account ••••1234",
        }),
      ).not.toBeInTheDocument(),
    );
    for (const key of linkedViews) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(disconnect).not.toHaveBeenCalled();
  });
});
