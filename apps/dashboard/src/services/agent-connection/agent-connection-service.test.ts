import { afterEach, describe, expect, it, vi } from "vitest";

import { answer, json, sent } from "@/test/mock-fetch";

import { agentConnectionService } from "./agent-connection-service";

const ID = "3f2b8c1e-6d4a-4b7e-9a10-2c5d7e8f9a0b";

const API_CONNECTION = {
  account_label: null,
  authorization: {
    authorization_url: "https://auth.example/login?state=abc",
    expires_at: "2026-11-06T03:00:00Z",
    poll_after_seconds: 5,
    requires_callback_url: true,
    user_code: null,
  },
  availability_status: "active",
  created_at: "2026-11-06T02:00:00Z",
  id: ID,
  provider: "claude",
  status: "pending",
  updated_at: "2026-11-06T02:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentConnectionService.start", () => {
  it("starts signing in to the agent and answers where to go", async () => {
    const spy = answer(json(201, API_CONNECTION));

    const connection = await agentConnectionService.start("claude");

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/agent-connections/start");
    expect(JSON.parse(String(request.body))).toEqual({ provider: "claude" });
    expect(request.credentials).toBe("include");
    expect(connection).toEqual({
      authorization: {
        needsCallbackUrl: true,
        pollAfterSeconds: 5,
        url: "https://auth.example/login?state=abc",
        userCode: null,
      },
      failureMessage: null,
      id: ID,
      label: null,
      plan: null,
      provider: "claude",
      status: "pending",
    });
  });

  it("answers the code to type, for a sign-in that finishes on its own", async () => {
    answer(
      json(201, {
        ...API_CONNECTION,
        authorization: {
          ...API_CONNECTION.authorization,
          requires_callback_url: false,
          user_code: "ABCD-1234",
        },
        provider: "grok",
      }),
    );

    const connection = await agentConnectionService.start("grok");

    expect(connection.authorization).toMatchObject({
      needsCallbackUrl: false,
      userCode: "ABCD-1234",
    });
  });

  it("fails with the API's message", async () => {
    answer(json(429, { code: "too_many_requests", message: "Slow down." }));

    await expect(agentConnectionService.start("claude")).rejects.toMatchObject({
      message: "Slow down.",
      status: 429,
    });
  });
});

describe("agentConnectionService.complete", () => {
  it("sends the address the provider sent the person back to, without its spaces", async () => {
    const spy = answer(
      json(200, {
        ...API_CONNECTION,
        account_label: "Shop Claude",
        authorization: null,
        plan: "Max 5x",
        status: "connected",
      }),
    );

    const connection = await agentConnectionService.complete(
      ID,
      "  http://localhost:1455/auth/callback?code=x&state=abc \n",
    );

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe(`/agent-connections/${ID}/complete`);
    expect(JSON.parse(String(request.body))).toEqual({
      callback_url: "http://localhost:1455/auth/callback?code=x&state=abc",
    });
    expect(connection).toMatchObject({
      authorization: null,
      label: "Shop Claude",
      plan: "Max 5x",
      status: "connected",
    });
  });

  it("fails with the API's message when the address is not right", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "The callback URL does not contain an authorization code.",
      }),
    );

    await expect(
      agentConnectionService.complete(ID, "nope"),
    ).rejects.toMatchObject({
      message: "The callback URL does not contain an authorization code.",
      status: 422,
    });
  });
});

describe("agentConnectionService.connectKey", () => {
  it.each([
    ["deepseek", "/agent-connections/deepseek"],
    ["groq", "/agent-connections/groq"],
  ] as const)("connects %s with its key", async (provider, path) => {
    const spy = answer(
      json(201, {
        ...API_CONNECTION,
        authorization: null,
        provider,
        status: "connected",
      }),
    );

    const connection = await agentConnectionService.connectKey(
      provider,
      "  fake-not-a-secret \n",
    );

    const request = await sent(spy);

    expect(request.path).toBe(path);
    expect(JSON.parse(String(request.body))).toEqual({
      api_key: "fake-not-a-secret",
    });
    expect(connection.status).toBe("connected");
  });

  it("fails with the API's message when the key is refused", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "The provider did not accept that key.",
      }),
    );

    await expect(
      agentConnectionService.connectKey("deepseek", "bad"),
    ).rejects.toMatchObject({
      message: "The provider did not accept that key.",
    });
  });
});

describe("agentConnectionService.get and disconnect", () => {
  it("reads where a connection stands", async () => {
    const spy = answer(
      json(200, {
        ...API_CONNECTION,
        status: "failed",
        failure_message: "Denied.",
      }),
    );

    const connection = await agentConnectionService.get(ID);

    expect((await sent(spy)).path).toBe(`/agent-connections/${ID}`);
    expect(connection).toMatchObject({
      failureMessage: "Denied.",
      status: "failed",
    });
  });

  it("lets go of a connection", async () => {
    const spy = answer(new Response(null, { status: 204 }));

    await expect(
      agentConnectionService.disconnect(ID),
    ).resolves.toBeUndefined();

    const request = await sent(spy);

    expect(request.method).toBe("DELETE");
    expect(request.path).toBe(`/agent-connections/${ID}`);
  });

  it("fails with the API's message when there is nothing to let go of", async () => {
    answer(json(404, { code: "not_found", message: "Gone." }));

    await expect(agentConnectionService.disconnect(ID)).rejects.toMatchObject({
      status: 404,
    });
  });
});
