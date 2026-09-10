import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
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

function poolFixture(requests: Array<Record<string, unknown>> = []) {
  return {
    account_label: "duy**@**.com",
    agent: "ChatGPT",
    availability: { retry_at: null as string | null, status: "active" },
    capacity: 6,
    created_at: "2026-09-04T08:30:00.000Z",
    id: "44444444-4444-4444-8444-444444444444",
    members: [{ avatar_label: "Syn", username: "synasapmob" }],
    owner: { avatar_label: "Syn", username: "synasapmob" },
    plan: "K12",
    requests,
    usage: [
      { detail: "Resets in 2h", label: "5-hour limit", value: "68% used" },
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

function renderRoute(user?: SessionFixture, initialPools = [poolFixture()]) {
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
              { avatar_label: "Huy", username: "huycodes" },
            ],
            requests: [accepted],
          },
        ];
        return jsonResponse(accepted);
      }
      if (url.endsWith("/members") && method === "POST") {
        const invited = { avatar_label: "Wil", username: "william" };
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
      if (url.endsWith("/retry") && method === "POST") {
        pools = [
          {
            ...pools[0],
            availability: { retry_at: null, status: "half_open" },
          },
        ];
        return jsonResponse({ retry_at: null, status: "half_open" });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsRoute", () => {
  it("loads real pools from the API and links Install to the gateway tool", async () => {
    const fetchMock = renderRoute();

    expect(screen.getByRole("link", { name: /install/i })).toHaveAttribute(
      "href",
      "/tools?node=gateway",
    );
    expect(await screen.findByText("duy**@**.com")).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([request]) =>
          request instanceof Request &&
          request.url === "http://localhost:8080/agent-pools",
      ),
    ).toBe(true);
  });

  it("shows no fixture cards when the API has no connected accounts", async () => {
    renderRoute(undefined, []);

    expect(await screen.findByText("No connected accounts yet.")).toBeVisible();
    expect(screen.queryByText("duy**@**.com")).not.toBeInTheDocument();
  });

  it("shows provider metadata and dynamic usage from the API", async () => {
    const user = userEvent.setup();
    renderRoute();

    expect((await screen.findAllByText("synasapmob"))[0]).toBeVisible();
    expect(screen.getByText("Syn")).toBeInTheDocument();
    expect(
      document.querySelector('img[src="/assets/chatgpt-icon.png"]'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /view usages/i }));
    expect(screen.getByText("5-hour limit")).toBeVisible();
    expect(screen.getByText("68% used")).toBeVisible();
  });

  it("gates a join request with the login and register dialog", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(
      await screen.findByRole("button", { name: /request join/i }),
    );
    expect(
      screen.getByRole("heading", { name: "Join the sharing community" }),
    ).toBeVisible();
  });

  it("persists a Telegram join request through the API", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "user-1", username: "newmember" });

    await user.click(
      await screen.findByRole("button", { name: /request join/i }),
    );
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

  it("lets the owner search and persist an accepted request", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner-1", username: "synasapmob" }, [
      poolFixture([pendingRequest]),
    ]);

    await user.click(
      await screen.findByRole("button", { name: /check request/i }),
    );
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
          { avatar_label: "Syn", username: "synasapmob" },
          { avatar_label: "Huy", username: "huycodes" },
        ],
      },
    ]);

    await user.click(
      await screen.findByRole("button", { name: /check request/i }),
    );
    await user.type(screen.getByLabelText("Invite member"), "william");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("william")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove huycodes" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove huycodes" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("arms an unavailable pool for its next real gateway request", async () => {
    const user = userEvent.setup();
    renderRoute({ id: "owner-1", username: "synasapmob" }, [
      {
        ...poolFixture(),
        availability: {
          retry_at: "2026-09-10T04:00:00.000Z",
          status: "rate_limited",
        },
      },
    ]);

    await user.click(
      await screen.findByRole("button", { name: /check request/i }),
    );
    expect(screen.getByText("Cooling down")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Ready to retry")).toBeVisible();
  });
});
