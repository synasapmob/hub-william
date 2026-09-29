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

describe.each([
  {
    call: () => organizationsService.deleteOrganization(organizationId),
    name: "deleteOrganization",
    path: `/organizations/${organizationId}`,
  },
  {
    call: () => organizationsService.leave(organizationId),
    name: "leave",
    path: `/organizations/${organizationId}/membership`,
  },
])("organizationsService.$name", ({ call, path }) => {
  it("sends one DELETE to the organization endpoint", async () => {
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
    expect(requests[0].method).toBe("DELETE");
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
        return requests.filter((item) => item.method === "DELETE").length === 1
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
      ["DELETE", path],
      ["POST", "/auth/refresh"],
      ["DELETE", path],
    ]);
  });
});
