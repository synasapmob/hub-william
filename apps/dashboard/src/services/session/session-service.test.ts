import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionService } from "./session-service";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const OWNER = {
  permissions: ["orders", "history", "stock", "revenue", "staff"],
  role: "owner",
  user: { id: "account-1", username: "minhanh" },
};

const REFRESHED = { user: { id: "account-1", username: "minhanh" } };

/** Answers each call to `fetch` in turn, and returns the spy to inspect them. */
function answers(...responses: (Response | Error)[]) {
  const spy = vi.spyOn(globalThis, "fetch");

  for (const response of responses)
    if (response instanceof Error) spy.mockRejectedValueOnce(response);
    else spy.mockResolvedValueOnce(response);

  return spy;
}

/** What was asked of the server, as `METHOD path`. */
function asked(spy: ReturnType<typeof answers>) {
  return spy.mock.calls.map(([request]) => {
    const { method, url } = request as Request;

    return `${method} ${new URL(url).pathname}`;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessionService.load", () => {
  it("is ready, with the role and what it may open, when the API says so", async () => {
    const spy = answers(json(200, OWNER));

    expect(await sessionService.load()).toEqual({
      identity: {
        id: "account-1",
        permissions: ["orders", "history", "stock", "revenue", "staff"],
        role: "owner",
        username: "minhanh",
      },
      status: "ready",
    });
    expect(asked(spy)).toEqual(["GET /dashboard/session"]);
    // The browser's own session cookie goes with it.
    expect((spy.mock.calls[0][0] as Request).credentials).toBe("include");
  });

  it("is forbidden, knowing who, for an account that is not staff", async () => {
    const spy = answers(
      json(403, { code: "forbidden", message: "No." }),
      json(200, REFRESHED),
    );

    expect(await sessionService.load()).toEqual({
      status: "forbidden",
      username: "minhanh",
    });
    // The refusal does not say whose it is, so the account is asked.
    expect(asked(spy)).toEqual(["GET /dashboard/session", "GET /auth/session"]);
  });

  it("is still forbidden when the account's name cannot be had", async () => {
    answers(
      json(403, { code: "forbidden", message: "No." }),
      new TypeError("Failed to fetch"),
    );

    expect(await sessionService.load()).toEqual({
      status: "forbidden",
      username: null,
    });
  });

  it("refreshes an expired session once, then asks again", async () => {
    const spy = answers(
      json(401, { code: "unauthorized", message: "Log in." }),
      json(200, REFRESHED),
      json(200, OWNER),
    );

    expect((await sessionService.load()).status).toBe("ready");
    expect(asked(spy)).toEqual([
      "GET /dashboard/session",
      "POST /auth/refresh",
      "GET /dashboard/session",
    ]);
  });

  it("is signed out when there is nothing to refresh", async () => {
    const spy = answers(
      json(401, { code: "unauthorized", message: "Log in." }),
      json(401, { code: "unauthorized", message: "Log in." }),
    );

    expect(await sessionService.load()).toEqual({ status: "signed-out" });
    // It does not loop: one refresh, no second try.
    expect(asked(spy)).toEqual([
      "GET /dashboard/session",
      "POST /auth/refresh",
    ]);
  });

  it("is forbidden, knowing who, when the refreshed account is not staff", async () => {
    answers(
      json(401, { code: "unauthorized", message: "Log in." }),
      json(200, REFRESHED),
      json(403, { code: "forbidden", message: "No." }),
    );

    expect(await sessionService.load()).toEqual({
      status: "forbidden",
      username: "minhanh",
    });
  });

  it("is unavailable when the server answers with an error", async () => {
    answers(json(500, { code: "internal_error", message: "Oops." }));

    expect(await sessionService.load()).toEqual({ status: "unavailable" });
  });

  it("is unavailable when the server cannot be reached", async () => {
    answers(new TypeError("Failed to fetch"));

    expect(await sessionService.load()).toEqual({ status: "unavailable" });
  });
});

describe("sessionService.login", () => {
  it("sends the username and password as they were typed", async () => {
    const spy = answers(json(200, REFRESHED));

    // It answers the username as the API keeps it.
    expect(
      await sessionService.login({
        password: "s3cret-pass",
        username: "minhanh",
      }),
    ).toBe("minhanh");

    const request = spy.mock.calls[0][0] as Request;

    expect(asked(spy)).toEqual(["POST /auth/login"]);
    expect(request.credentials).toBe("include");
    expect(await request.clone().json()).toEqual({
      password: "s3cret-pass",
      username: "minhanh",
    });
  });

  it("raises the API's own message when the account is refused", async () => {
    answers(
      json(401, {
        code: "invalid_credentials",
        message: "The username or password is incorrect.",
      }),
    );

    await expect(
      sessionService.login({ password: "wrong", username: "minhanh" }),
    ).rejects.toMatchObject({
      code: "invalid_credentials",
      message: "The username or password is incorrect.",
      status: 401,
    });
  });

  it("says the server cannot be reached when it cannot", async () => {
    answers(new TypeError("Failed to fetch"));

    await expect(
      sessionService.login({ password: "x", username: "y" }),
    ).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});

describe("sessionService.register", () => {
  it("sends the username, recovery email and password as they were typed", async () => {
    const spy = answers(json(201, REFRESHED));

    // The API lowercases the username, and the page is told what it kept.
    expect(
      await sessionService.register({
        password: "s3cret-pass",
        recoveryEmail: "an@example.com",
        username: "An_Binh",
      }),
    ).toBe("minhanh");

    const request = spy.mock.calls[0][0] as Request;

    expect(asked(spy)).toEqual(["POST /auth/register"]);
    expect(request.credentials).toBe("include");
    expect(await request.clone().json()).toEqual({
      password: "s3cret-pass",
      recovery_email: "an@example.com",
      username: "An_Binh",
    });
  });

  it.each([
    [409, "username_taken", "That username is already registered."],
    [422, "validation_error", "Password must be between 8 and 128 characters."],
  ])(
    "raises the API's own message when it answers %i",
    async (status, code, message) => {
      answers(json(status, { code, message }));

      await expect(
        sessionService.register({
          password: "s3cret-pass",
          recoveryEmail: "an@example.com",
          username: "an_binh",
        }),
      ).rejects.toMatchObject({ code, message, status });
    },
  );

  it("says the server cannot be reached when it cannot", async () => {
    answers(new TypeError("Failed to fetch"));

    await expect(
      sessionService.register({
        password: "s3cret-pass",
        recoveryEmail: "an@example.com",
        username: "an_binh",
      }),
    ).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});

describe("sessionService.logout", () => {
  it("ends the session on the server", async () => {
    const spy = answers(new Response(null, { status: 204 }));

    await sessionService.logout();

    expect(asked(spy)).toEqual(["POST /auth/logout"]);
  });
});
