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
