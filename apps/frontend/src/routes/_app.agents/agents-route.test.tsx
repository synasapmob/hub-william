import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import authService, { type AuthenticatedUser } from "@/services/auth";
import createQueryClient from "@/utils/utils.query-client";

import AgentsRoute from "./route";

interface SessionFixture {
  id: string;
  recoveryEmail?: string | null;
  username: string;
}

const pendingRequest = {
  avatar_label: "Huy",
  id: "55555555-5555-4555-8555-555555555555",
  reason: "I use Codex for an open-source Rust project after work.",
  status: "pending",
  telegram: "@huycodes",
  username: "huycodes",
} as const;

function sharePayload(
  percent: number,
  values: {
    budget?: number | null;
    cap?: number | null;
    failOpen?: string | null;
    memberCount?: number;
    poolCached?: number;
    poolInput?: number;
    poolOutput?: number;
    providerUsed?: number | null;
    remaining?: number | null;
    userCached?: number;
    userInput?: number;
    userOutput?: number;
    window?: string | null;
  } = {},
) {
  const userInput = values.userInput ?? 0;
  const userOutput = values.userOutput ?? 0;
  const userCached = values.userCached ?? 0;
  const poolInput = values.poolInput ?? 0;
  const poolOutput = values.poolOutput ?? 0;
  const poolCached = values.poolCached ?? 0;

  return {
    available_percent: percent,
    budget_units: values.budget ?? null,
    cap_units: values.cap ?? null,
    fail_open_reason:
      values.failOpen === undefined
        ? "Hub has not recorded gateway tokens in this window."
        : values.failOpen,
    member_count: values.memberCount ?? 1,
    pool_cached_tokens: poolCached,
    pool_input_tokens: poolInput,
    pool_output_tokens: poolOutput,
    pool_units: poolInput + poolOutput + poolCached,
    provider_used_percent: values.providerUsed ?? null,
    remaining_units: values.remaining ?? null,
    user_cached_tokens: userCached,
    user_input_tokens: userInput,
    user_output_tokens: userOutput,
    user_units: userInput + userOutput + userCached,
    window_label: values.window ?? null,
  };
}

function apiPerson(
  username: string,
  values: {
    avatar_label?: string;
    joined_at?: string;
    share?: ReturnType<typeof sharePayload>;
    usage_available_percent?: number;
  } = {},
) {
  const percent = values.usage_available_percent ?? 100;

  return {
    avatar_label:
      values.avatar_label ??
      username.slice(0, 3).replace(/^./, (letter) => letter.toUpperCase()),
    joined_at: values.joined_at ?? "2026-09-04T08:30:00.000Z",
    share: values.share ?? sharePayload(percent),
    usage_available_percent: percent,
    username,
  };
}

function poolFixture(requests: Array<Record<string, unknown>> = []) {
  return {
    account_label: "du**y@exa**.com",
    agent: "ChatGPT",
    availability: { retry_at: null as string | null, status: "active" },
    capacity: 6,
    created_at: "2026-09-04T08:30:00.000Z",
    id: "44444444-4444-4444-8444-444444444444",
    members: [apiPerson("synasapmob", { avatar_label: "Syn" })],
    owner: apiPerson("synasapmob", { avatar_label: "Syn" }),
    plan: "K12",
    requests,
    usage: [
      { detail: "Resets in 2h", label: "5-hour limit", value: "68% used" },
    ],
  };
}

function populatedPoolFixture(requests: Array<Record<string, unknown>> = []) {
  const pool = poolFixture(requests);
  return {
    ...pool,
    members: [
      ...pool.members,
      ...Array.from({ length: 7 }, (_, index) => apiPerson(`member${index}`)),
    ],
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function sessionResponse(user?: SessionFixture) {
  return user
    ? jsonResponse({
        user: {
          id: user.id,
          recovery_email: user.recoveryEmail ?? null,
          username: user.username,
        },
      })
    : jsonResponse({ message: "Log in to continue." }, 401);
}

function renderRoute(
  user?: SessionFixture,
  initialPools = [poolFixture()],
  reauthorizationRequired = false,
) {
  let pools = initialPools;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/auth/session")) return sessionResponse(user);
      if (url.endsWith("/auth/refresh")) return sessionResponse();
      if (url.endsWith("/agent-pools") && method === "GET") {
        return jsonResponse(pools);
      }
      if (url.includes("/agent-pools/") && url.endsWith("/requests")) {
        const request = {
          avatar_label: "New",
          id: "66666666-6666-4666-8666-666666666666",
          reason: "I want to share the account for open-source development.",
          status: "pending",
          telegram: "@newmember",
          username: "newmember",
        };
        pools = [{ ...pools[0], requests: [request] }];
        return jsonResponse(request, 201);
      }
      if (url.includes("/agent-pool-requests/") && url.endsWith("/decision")) {
        const accepted = { ...pendingRequest, status: "accepted" };
        pools = [
          {
            ...pools[0],
            members: [
              ...pools[0].members,
              apiPerson("huycodes", {
                avatar_label: "Huy",
                joined_at: "2026-09-12T08:00:00.000Z",
              }),
            ],
            requests: [accepted],
          },
        ];
        return jsonResponse(accepted);
      }
      if (url.endsWith("/members") && method === "POST") {
        const invited = apiPerson("william", {
          avatar_label: "Wil",
          joined_at: "2026-09-12T09:00:00.000Z",
        });
        pools = [
          {
            ...pools[0],
            members: [...pools[0].members, invited],
          },
        ];
        return jsonResponse(invited, 201);
      }
      if (url.includes("/members/") && method === "DELETE") {
        pools = [
          {
            ...pools[0],
            members: pools[0].members.filter(
              (member) => member.username !== "huycodes",
            ),
          },
        ];
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/refresh") && method === "POST") {
        const authorization = reauthorizationRequired
          ? {
              authorization_url:
                "https://claude.com/oauth/authorize?refresh=true",
              expires_at: "2026-09-14T17:00:00.000Z",
              poll_after_seconds: 5,
              requires_callback_url: true,
              user_code: null,
            }
          : null;
        pools = [
          {
            ...pools[0],
            availability: {
              retry_at: null,
              status: reauthorizationRequired ? "reauth_required" : "active",
            },
          },
        ];
        return jsonResponse({
          account_label: "du**y@exa**.com",
          authorization,
          created_at: "2026-09-04T08:30:00.000Z",
          failure_message: null,
          id: "44444444-4444-4444-8444-444444444444",
          plan: "K12",
          provider: pools[0].agent.toLowerCase(),
          status: "connected",
          updated_at: "2026-09-14T15:58:00.000Z",
        });
      }
      if (url.endsWith("/complete") && method === "POST") {
        pools = [
          {
            ...pools[0],
            availability: { retry_at: null, status: "active" },
          },
        ];
        return jsonResponse({
          account_label: "du**y@exa**.com",
          authorization: null,
          created_at: "2026-09-04T08:30:00.000Z",
          failure_message: null,
          id: "44444444-4444-4444-8444-444444444444",
          plan: "K12",
          provider: "chatgpt",
          status: "connected",
          updated_at: "2026-09-14T15:59:00.000Z",
        });
      }
      if (url.includes("/agent-connections/") && method === "DELETE") {
        pools = pools.filter(
          (pool) => !url.endsWith(`/agent-connections/${pool.id}`),
        );
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/agent-connections") || url.endsWith("/gateway-keys")) {
        return jsonResponse([]);
      }

      return jsonResponse({ message: "Not found" }, 404);
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <WorkspaceShellSession>
          <AgentsRoute />
        </WorkspaceShellSession>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return fetchMock;
}

async function openAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", {
      name: /^Open (ChatGPT|Claude|Gemini|Grok|DeepSeek) account /,
    }),
  );
}

beforeEach(() => {
  // JSDOM has no layout observer; real connector/tooltip geometry is browser-verified.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentsRoute", () => {
  it.each(["guest", "authenticated"] as const)(
    "waits for the %s session and fetches pools once",
    async (status) => {
      let resolveSession!: (user: AuthenticatedUser | null) => void;
      const pendingSession = new Promise<AuthenticatedUser | null>(
        (resolve) => {
          resolveSession = resolve;
        },
      );
      vi.spyOn(authService, "session").mockReturnValue(pendingSession);
      const fetchMock = renderRoute();
      const poolRequests = () =>
        fetchMock.mock.calls.filter(([input]) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.endsWith("/agent-pools");
        });
      expect(
        await screen.findByRole("status", {
          name: "Provider and account explorer",
        }),
      ).toBeVisible();
      expect(poolRequests()).toHaveLength(0);
      resolveSession(
        status === "authenticated"
          ? { id: "owner", username: "synasapmob", recoveryEmail: null }
          : null,
      );
      const account = await screen.findByRole("button", {
        name: "Open ChatGPT account du**y@exa**.com",
      });
      expect(account).toHaveTextContent(
        status === "authenticated" ? "Owner" : "Open to join",
      );
      expect(poolRequests()).toHaveLength(1);
    },
  );

  it("loads real pools from the API and links Install to the gateway tool", async () => {
    const fetchMock = renderRoute();

    expect(screen.getByRole("link", { name: /install/i })).toHaveAttribute(
      "href",
      "/tools?node=gateway",
    );
    expect(await screen.findByText("du**y@exa**.com")).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([request]) =>
          request instanceof Request &&
          request.url === "http://localhost:8080/agent-pools",
      ),
    ).toBe(true);
  });

  it("keeps the provider and account layout while the list loads", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith("/auth/session")) return sessionResponse();
      if (url.endsWith("/agent-pools")) {
        return new Promise<Response>(() => {});
      }

      return jsonResponse({ message: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <WorkspaceShellSession>
            <AgentsRoute />
          </WorkspaceShellSession>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const status = await screen.findByRole("status");
    expect(screen.getByText("Loading connected accounts")).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(
      within(status).getByRole("navigation", { name: "Agent providers" }),
    ).toBeVisible();
    const accounts = within(status).getByRole("region", {
      name: "ChatGPT accounts",
    });
    expect(accounts.querySelectorAll("li")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Connect Agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Gateway Key" })).toBeVisible();
    expect(screen.queryByText("du**y@exa**.com")).not.toBeInTheDocument();
  });

  it("shows no fixture cards when the API has no connected accounts", async () => {
    renderRoute(undefined, []);

    expect(await screen.findByText("No connected accounts yet.")).toBeVisible();
    expect(screen.queryByText("du**y@exa**.com")).not.toBeInTheDocument();
  });

  it("shows provider metadata and dynamic usage from the API", async () => {
    const user = userEvent.setup();
    renderRoute();

    const account = await screen.findByRole("button", {
      name: "Open ChatGPT account du**y@exa**.com",
    });
    expect(account).toHaveTextContent("32% remaining");
    expect(account).toHaveTextContent("5-hour limit");
    await user.click(account);

    const detail = screen.getByRole("article", {
      name: "ChatGPT account du**y@exa**.com details",
    });
    expect(within(detail).getAllByText("synasapmob").length).toBeGreaterThan(0);
    expect(within(detail).getByText("Syn")).toBeInTheDocument();
    expect(within(detail).getByText("5-hour limit")).toBeVisible();
    expect(
      within(detail).getByText("32% remaining", { exact: true }),
    ).toBeVisible();
    expect(within(detail).getByText("Resets in 2h")).toBeVisible();
    expect(within(detail).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "32",
    );
  });

  it("shows joined members and join date", async () => {
    const user = userEvent.setup();
    renderRoute(undefined, [
      {
        ...poolFixture(),
        members: [
          apiPerson("synasapmob", { avatar_label: "Syn" }),
          apiPerson("huycodes", {
            avatar_label: "Huy",
            joined_at: "2026-09-10T12:00:00.000Z",
          }),
        ],
      },
    ]);
    await openAccount(user);
    const detail = screen.getByRole("article");
    await user.click(within(detail).getByText("Members · 2"));
    expect(within(detail).getAllByText("huycodes").length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("synasapmob").length).toBeGreaterThan(0);
    expect(
      detail.querySelector('time[datetime="2026-09-10T12:00:00.000Z"]'),
    ).toBeVisible();
  });

  it("says so when a provider reports no usage instead of opening blank", async () => {
    const user = userEvent.setup();
    renderRoute(undefined, [{ ...poolFixture(), usage: [] }]);
    expect(
      await screen.findByRole("button", { name: /^Open ChatGPT account / }),
    ).toHaveTextContent("Unavailable");
    await openAccount(user);
    expect(
      screen.getByText("ChatGPT has not reported usage for this account yet."),
    ).toBeVisible();
    expect(screen.queryByText("5-hour limit")).not.toBeInTheDocument();
  });

  it("opens one account popup, restores focus and filters the provider list", async () => {
    const user = userEvent.setup();
    const second = {
      ...poolFixture(),
      account_label: "se**@exa**.com",
      id: "second",
    };
    const grok = {
      ...poolFixture(),
      account_label: "gr**@exa**.com",
      agent: "Grok",
      id: "grok",
      usage: [
        { label: "Monthly limit", value: "64% remaining", detail: "September" },
      ],
    };
    renderRoute(undefined, [poolFixture(), second, grok]);
    const firstButton = await screen.findByRole("button", {
      name: "Open ChatGPT account du**y@exa**.com",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /accounts/i }),
    ).not.toBeInTheDocument();
    expect(firstButton).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(firstButton);
    expect(
      screen.getByRole("dialog", {
        name: "ChatGPT account du**y@exa**.com details",
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(firstButton).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const secondButton = screen.getByRole("button", {
      name: "Open ChatGPT account se**@exa**.com",
    });
    await user.click(secondButton);
    expect(
      screen.getByRole("dialog", {
        name: "ChatGPT account se**@exa**.com details",
      }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Close ChatGPT account se**@exa**.com details",
      }),
    );
    await waitFor(() => expect(secondButton).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Grok, 1 accounts" }));
    expect(
      screen.queryByRole("button", {
        name: "Open ChatGPT account du**y@exa**.com",
      }),
    ).not.toBeInTheDocument();
    const grokButton = screen.getByRole("button", {
      name: "Open Grok account gr**@exa**.com",
    });
    expect(grokButton).toHaveTextContent("Monthly limit");
    expect(grokButton).not.toHaveTextContent("5-hour limit");
    await user.click(grokButton);
    expect(
      screen.getByRole("dialog", {
        name: "Grok account gr**@exa**.com details",
      }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await user.type(
      screen.getByRole("textbox", { name: "Search accounts" }),
      "no-match",
    );
    expect(
      screen.getByText("No accounts match. Try another provider or filter."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Open .* account / }),
    ).not.toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search accounts" }));
    expect(
      screen.getByRole("button", { name: "Open Grok account gr**@exa**.com" }),
    ).toBeVisible();
  });

  it("filters owned and joined accounts while keeping header actions available", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner", username: "synasapmob" }, [
      poolFixture(),
      {
        ...poolFixture(),
        id: "joined",
        account_label: "jo**@exa**.com",
        owner: apiPerson("alice"),
        members: [apiPerson("alice"), apiPerson("synasapmob")],
      },
    ]);
    await screen.findByRole("button", {
      name: "Open ChatGPT account du**y@exa**.com",
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter accounts" }),
      "mine",
    );
    expect(
      screen.getByRole("button", {
        name: "Open ChatGPT account du**y@exa**.com",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Open ChatGPT account jo**@exa**.com",
      }),
    ).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter accounts" }),
      "joined",
    );
    expect(
      screen.getByRole("button", {
        name: "Open ChatGPT account jo**@exa**.com",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Open ChatGPT account du**y@exa**.com",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Gateway Key" })).toBeVisible();
  });

  it("surfaces exhausted secondary quotas without hiding the primary window", async () => {
    renderRoute(undefined, [
      {
        ...poolFixture(),
        usage: [
          {
            label: "5-hour limit",
            value: "72% remaining",
            detail: "Resets in 3h",
          },
          {
            label: "Weekly limit",
            value: "0% remaining",
            detail: "Resets in 4d",
          },
        ],
      },
    ]);
    const account = await screen.findByRole("button", {
      name: /^Open ChatGPT account /,
    });
    expect(account).toHaveTextContent("72% remaining");
    expect(account).toHaveTextContent("Weekly limit exhausted");
  });

  it("gates a join request with the login and register dialog", async () => {
    const user = userEvent.setup();
    renderRoute();

    await openAccount(user);
    await user.click(screen.getByRole("button", { name: /request join/i }));
    expect(
      screen.getByRole("heading", { name: "Join the sharing community" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Request Join" }),
      ).toHaveFocus(),
    );
  });

  it("keeps the account popup and focus while successful login reloads pools", async () => {
    const user = userEvent.setup();
    const fetchMock = renderRoute();
    await openAccount(user);
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolvePools!: (response: Response) => void;
    const reloadedPools = new Promise<Response>((resolve) => {
      resolvePools = resolve;
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/login"))
        return sessionResponse({ id: "new-user", username: "newmember" });
      if (url.endsWith("/agent-pools")) return reloadedPools;
      return originalFetch(input, init);
    });
    await user.click(screen.getByRole("button", { name: "Request Join" }));
    await user.type(
      screen.getByLabelText("Username", { exact: true }),
      "newmember",
    );
    await user.type(
      screen.getByLabelText("Password", { exact: true }),
      "secret-pass",
    );
    await user.click(screen.getByRole("button", { name: "Login" }));
    const detail = await screen.findByRole("dialog", {
      name: "ChatGPT account du**y@exa**.com details",
    });
    expect(detail).toBeVisible();
    await waitFor(() =>
      expect(
        within(detail).getByRole("button", { name: "Request Join" }),
      ).toHaveFocus(),
    );
    resolvePools(jsonResponse([poolFixture()]));
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-agent-node="account:44444444-4444-4444-8444-444444444444"]',
        ),
      ).not.toBeNull(),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Open ChatGPT account du**y@exa**.com",
        }),
      ).toHaveFocus(),
    );
  });

  it("returns from management and join dialogs to the account popup", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner", username: "synasapmob" }, [
      poolFixture(),
      {
        ...poolFixture(),
        id: "other",
        account_label: "al**@exa**.com",
        owner: apiPerson("alice"),
        members: [apiPerson("alice")],
      },
    ]);
    await user.click(
      await screen.findByRole("button", {
        name: "Open ChatGPT account du**y@exa**.com",
      }),
    );
    const manage = screen.getByRole("button", { name: "Manage" });
    await user.click(manage);
    expect(
      screen.getByRole("dialog", { name: "Manage pool access" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(manage).toHaveFocus());
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", {
        name: "Open ChatGPT account al**@exa**.com",
      }),
    );
    const join = screen.getByRole("button", { name: "Request Join" });
    await user.click(join);
    expect(
      screen.getByRole("dialog", { name: "Request to join alice's pool" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(join).toHaveFocus());
    expect(
      screen.getByRole("dialog", {
        name: "ChatGPT account al**@exa**.com details",
      }),
    ).toBeVisible();
  });

  it("persists a join request beyond the legacy member capacity", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "user-1", username: "newmember" }, [
      populatedPoolFixture(),
    ]);

    await openAccount(user);
    expect(screen.getByText("Members · 8")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /request join/i }));
    await user.type(screen.getByLabelText("Telegram username"), "@newmember");
    await user.type(
      screen.getByLabelText("Why do you want to join?"),
      "I want to share the account for open-source development.",
    );
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(
      await screen.findByRole("button", { name: /request pending/i }),
    ).toBeDisabled();
  });

  it("lets the owner accept a request beyond the legacy member capacity", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner-1", username: "synasapmob" }, [
      populatedPoolFixture([pendingRequest]),
    ]);

    await openAccount(user);
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.type(
      screen.getByPlaceholderText("Search username or Telegram"),
      "huycodes",
    );
    expect(screen.getByText("@huycodes")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(screen.getAllByText("Huy").length).toBeGreaterThan(0),
    );
  });

  it("lets the owner invite and remove pool members", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner-1", username: "synasapmob" }, [
      {
        ...poolFixture(),
        members: [
          apiPerson("synasapmob", {
            avatar_label: "Syn",
            share: sharePayload(40, {
              budget: 200,
              cap: 100,
              failOpen: null,
              memberCount: 2,
              poolInput: 80,
              poolOutput: 20,
              providerUsed: 50,
              remaining: 40,
              userInput: 48,
              userOutput: 12,
              window: "5-hour limit",
            }),
            usage_available_percent: 40,
          }),
          apiPerson("huycodes", {
            avatar_label: "Huy",
            joined_at: "2026-09-10T12:00:00.000Z",
            share: sharePayload(85, {
              budget: 200,
              cap: 100,
              failOpen: null,
              memberCount: 2,
              poolInput: 80,
              poolOutput: 20,
              providerUsed: 50,
              remaining: 85,
              userInput: 12,
              userOutput: 3,
              window: "5-hour limit",
            }),
            usage_available_percent: 85,
          }),
        ],
      },
    ]);

    await openAccount(user);
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.type(screen.getByLabelText("Invite member"), "william");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(
      await within(screen.getByRole("dialog")).findByText("william"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove huycodes" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove huycodes" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("lets the owner delete the connected account pool", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner-1", username: "synasapmob" });

    await openAccount(user);
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No connected accounts yet.")).toBeVisible();
    expect(screen.queryByText("Manage pool access")).not.toBeInTheDocument();
  });

  it("refreshes the latest provider credential for an active pool", async () => {
    const popup = {
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const user = userEvent.setup();
    renderRoute({ id: "owner-1", username: "synasapmob" });

    await openAccount(user);
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(
      within(screen.getByRole("dialog")).getByText("Active"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await within(screen.getByRole("dialog")).findByText("Active"),
    ).toBeVisible();
    expect(screen.getByText("Provider credential refreshed")).toBeVisible();
    expect(popup.close).toHaveBeenCalled();
  });

  it("opens provider authorization and reconnects the same pool when refresh is rejected", async () => {
    const popup = {
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const user = userEvent.setup();
    renderRoute(
      { id: "owner-1", username: "synasapmob" },
      [
        {
          ...poolFixture(),
          agent: "Claude",
          availability: { retry_at: null, status: "reauth_required" },
        },
      ],
      true,
    );

    await openAccount(user);
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(
      within(screen.getByRole("dialog")).getByText("Reconnect required"),
    ).toBeVisible();
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
    expect(
      within(screen.getByRole("dialog")).getByText("Active"),
    ).toBeVisible();
  });
});
