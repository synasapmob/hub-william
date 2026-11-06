import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import type { SessionState } from "@/services/session/session-service";

import createQueryClient from "./utils.query-client";

// The toaster is not rendered here, so a toast is read from the calls made to it.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

const SESSION_KEY = ["dashboard", "session"];

const READY: SessionState = {
  identity: {
    id: "account-1",
    permissions: ["orders"],
    role: "cashier",
    username: "thuha",
  },
  status: "ready",
};

const EXPIRED = new ServiceError("Log in to continue.", 401, "unauthorized");
const WRONG_PASSWORD = new ServiceError(
  "The username or password is incorrect.",
  401,
  "invalid_credentials",
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a query that fails", () => {
  it("is told to the person in a toast, whichever page asked", async () => {
    const client = createQueryClient();

    await client
      .fetchQuery({
        queryFn: () =>
          Promise.reject(new ServiceError("Máy chủ đang bận.", 503, null)),
        queryKey: ["dashboard", "orders"],
      })
      .catch(() => {});

    expect(toast.error).toHaveBeenCalledWith("Máy chủ đang bận.", {
      id: expect.any(String),
    });
  });

  it("replaces its own toast when it fails again, instead of stacking another", async () => {
    const client = createQueryClient();
    const fail = () =>
      client
        .fetchQuery({
          queryFn: () =>
            Promise.reject(new ServiceError("Máy chủ đang bận.", 503, null)),
          queryKey: ["dashboard", "orders", { page: 1 }],
          staleTime: 0,
        })
        .catch(() => {});

    await fail();
    await fail();

    const [first, second] = vi.mocked(toast.error).mock.calls;

    expect(first[1]).toEqual(second[1]);
  });

  it("does not toast the session's own states, which have a screen each", async () => {
    const client = createQueryClient();

    await client
      .fetchQuery({
        queryFn: () => Promise.reject(new Error("Boom")),
        queryKey: SESSION_KEY,
      })
      .catch(() => {});

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ends the session, once, when it is no longer there", async () => {
    const client = createQueryClient();

    client.setQueryData(SESSION_KEY, READY);
    await client
      .fetchQuery({
        queryFn: () => Promise.reject(EXPIRED),
        queryKey: ["dashboard", "orders"],
      })
      .catch(() => {});

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Your session has expired", {
      description: "Log in again to continue.",
      id: "session-expired",
    });
    expect(client.getQueryData(SESSION_KEY)).toEqual({ status: "signed-out" });
  });
});

describe("a change that fails", () => {
  it("is left to the page that asked for it", async () => {
    const client = createQueryClient();

    await client
      .getMutationCache()
      .build(client, {
        mutationFn: () =>
          Promise.reject(new ServiceError("No.", 422, "validation_error")),
      })
      .execute(undefined)
      .catch(() => {});

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ends the session when it is no longer there", async () => {
    const client = createQueryClient();

    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(EXPIRED) })
      .execute(undefined)
      .catch(() => {});

    expect(toast.error).toHaveBeenCalledWith("Your session has expired", {
      description: "Log in again to continue.",
      id: "session-expired",
    });
    expect(client.getQueryData(SESSION_KEY)).toEqual({ status: "signed-out" });
  });

  it("does not take a wrong password for an expired session", async () => {
    const client = createQueryClient();

    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(WRONG_PASSWORD) })
      .execute(undefined)
      .catch(() => {});

    expect(toast.error).not.toHaveBeenCalled();
    expect(client.getQueryData(SESSION_KEY)).toBeUndefined();
  });
});
