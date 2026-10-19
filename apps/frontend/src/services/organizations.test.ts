import { afterEach, describe, expect, it, vi } from "vitest";

import organizationsService from "./organizations";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const organizationId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";

describe("organizationsService.addAgent", () => {
  it.each([
    [201, "a new share"],
    [200, "an account that is already shared"],
  ])(
    "treats HTTP %i for %s as a successful link to the Workspace account",
    async (status) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request);
          return Response.json(
            {
              account_label: "••••1234",
              availability_status: "active",
              created_at: "2026-09-23T00:00:00Z",
              id: connectionId,
              owner_username: "minh",
              provider: "deepseek",
              rate_limited_until: null,
            },
            { status },
          );
        }),
      );

      await expect(
        organizationsService.addAgent(organizationId, connectionId),
      ).resolves.toEqual({
        accountLabel: "••••1234",
        availabilityStatus: "active",
        createdAt: "2026-09-23T00:00:00Z",
        id: connectionId,
        ownerUsername: "minh",
        provider: "deepseek",
        rateLimitedUntil: null,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("POST");
      expect(new URL(requests[0].url).pathname).toBe(
        `/organizations/${organizationId}/agents`,
      );
      expect(await requests[0].json()).toEqual({
        connection_id: connectionId,
      });
    },
  );
});

describe("organizationsService.list", () => {
  it("maps the organizations the viewer belongs to and which is their default", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json([
          {
            created_at: "2026-09-20T12:00:00Z",
            description: null,
            id: organizationId,
            is_default: true,
            name: "Team Mây",
            role: "member",
          },
        ]);
      }),
    );

    // TanStack Query hands its query function a context object, so the
    // service call must not read its arguments.
    await expect(
      (organizationsService.list as (context: object) => Promise<unknown>)({
        queryKey: [],
      }),
    ).resolves.toEqual([
      {
        createdAt: "2026-09-20T12:00:00Z",
        description: null,
        id: organizationId,
        isDefault: true,
        name: "Team Mây",
        role: "member",
      },
    ]);

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/organizations");
    expect(url.search).toBe("");
  });
});

describe("organizationsService.summaries", () => {
  it("asks for the recent usage window and maps each summary", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json([
          {
            agent_count: 3,
            created_at: "2026-09-20T12:00:00Z",
            description: "The platform team",
            id: organizationId,
            is_default: true,
            known_cached_tokens: 5,
            known_input_tokens: 1200,
            known_output_tokens: 300,
            member_count: 4,
            name: "Team Mây",
            owner_username: "minh",
            period_days: 30,
            requests: 9,
            role: "owner",
            token_known_requests: 8,
          },
        ]);
      }),
    );

    await expect(organizationsService.summaries()).resolves.toEqual([
      {
        agentCount: 3,
        createdAt: "2026-09-20T12:00:00Z",
        description: "The platform team",
        id: organizationId,
        isDefault: true,
        knownCachedTokens: 5,
        knownInputTokens: 1200,
        knownOutputTokens: 300,
        memberCount: 4,
        name: "Team Mây",
        ownerUsername: "minh",
        periodDays: 30,
        requests: 9,
        role: "owner",
        tokenKnownRequests: 8,
      },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/organization-summaries");
    expect(url.searchParams.get("days")).toBe("30");
  });

  it("does not read its arguments, so a query can run it as is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );

    await expect(
      (organizationsService.summaries as (context: object) => Promise<unknown>)(
        { queryKey: [] },
      ),
    ).resolves.toEqual([]);
  });
});

describe.each([
  {
    call: () => organizationsService.deleteOrganization(organizationId),
    method: "DELETE",
    name: "deleteOrganization",
    path: `/organizations/${organizationId}`,
  },
  {
    call: () => organizationsService.leave(organizationId),
    method: "DELETE",
    name: "leave",
    path: `/organizations/${organizationId}/membership`,
  },
  {
    call: () => organizationsService.setDefault(organizationId),
    method: "PUT",
    name: "setDefault",
    path: `/organizations/${organizationId}/default`,
  },
])("organizationsService.$name", ({ call, method, path }) => {
  it("sends one request to the organization endpoint", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response(null, { status: 204 });
      }),
    );

    await expect(call()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe(method);
    expect(new URL(requests[0].url).pathname).toBe(path);
  });

  it("surfaces the API's refusal instead of reporting success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "forbidden", message: "Not allowed here." },
          { status: 403 },
        ),
      ),
    );

    await expect(call()).rejects.toThrow("Not allowed here.");
  });

  it("fails clearly when the API predates the endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(call()).rejects.toThrow(
      "The organization request could not be completed.",
    );
  });

  it("retries once after refreshing an expired session", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        const { pathname } = new URL(request.url);
        if (pathname === "/auth/refresh")
          return Response.json({
            user: {
              id: "33333333-3333-4333-8333-333333333333",
              username: "ban",
            },
          });
        return requests.filter((item) => item.method === method).length === 1
          ? Response.json(
              { code: "unauthorized", message: "Log in to continue." },
              { status: 401 },
            )
          : new Response(null, { status: 204 });
      }),
    );

    await expect(call()).resolves.toBeUndefined();

    expect(
      requests.map((request) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      [method, path],
      ["POST", "/auth/refresh"],
      [method, path],
    ]);
  });
});
