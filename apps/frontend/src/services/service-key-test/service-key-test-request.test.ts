import { describe, expect, it } from "vitest";

import {
  serviceKeyCurl,
  serviceKeyTestRequest,
  TEST_MESSAGE,
} from "./service-key-test-request";

const input = {
  message: "Hello, how are you?",
  model: "m-1",
  origin: "https://hub.example.test/api/",
};

describe("serviceKeyTestRequest", () => {
  it.each([
    ["chatgpt", "/gateway/openai/v1/responses"],
    ["grok", "/gateway/grok/v1/responses"],
    ["deepseek", "/gateway/deepseek/responses"],
    ["groq", "/gateway/groq/v1/responses"],
  ] as const)(
    "sends %s a Responses body to its own gateway route",
    (provider, route) => {
      const { body, url } = serviceKeyTestRequest({ ...input, provider });

      expect(url).toBe(`https://hub.example.test/api${route}`);
      expect(body).toMatchObject({
        input: [
          {
            content: [{ text: "Hello, how are you?", type: "input_text" }],
            role: "user",
          },
        ],
        model: "m-1",
        stream: true,
      });
    },
  );

  it("sends the agents that need it store false, and Groq not", () => {
    expect(
      serviceKeyTestRequest({ ...input, provider: "chatgpt" }).body,
    ).toMatchObject({ store: false });
    expect(
      serviceKeyTestRequest({ ...input, provider: "groq" }).body,
    ).not.toHaveProperty("store");
  });

  it("sends Claude Messages with a token limit", () => {
    expect(serviceKeyTestRequest({ ...input, provider: "claude" })).toEqual({
      body: {
        max_tokens: 4096,
        messages: [{ content: "Hello, how are you?", role: "user" }],
        model: "m-1",
        stream: true,
      },
      url: "https://hub.example.test/api/gateway/claude/v1/messages",
    });
  });

  it("names the Gemini model in the route, without its models/ prefix", () => {
    expect(
      serviceKeyTestRequest({
        ...input,
        model: "models/gemini-4-argon",
        provider: "gemini",
      }),
    ).toEqual({
      body: {
        contents: [{ parts: [{ text: "Hello, how are you?" }], role: "user" }],
      },
      url: "https://hub.example.test/api/gateway/gemini/v1beta/models/gemini-4-argon:streamGenerateContent",
    });
  });
});

describe("serviceKeyCurl", () => {
  it("is a command with the key, the route and the body", () => {
    const curl = serviceKeyCurl({
      ...input,
      key: "YOUR_SERVICE_KEY",
      provider: "deepseek",
    });

    expect(curl).toContain(
      "curl -N https://hub.example.test/api/gateway/deepseek/responses",
    );
    expect(curl).toContain('-H "Authorization: Bearer YOUR_SERVICE_KEY"');
    expect(curl).toContain('-H "Content-Type: application/json"');
    expect(curl).toContain('"model":"m-1"');
  });

  it("closes and reopens the single quotes around a quote in the message", () => {
    const curl = serviceKeyCurl({
      ...input,
      key: "k",
      message: "What's 2 + 2?",
      provider: "deepseek",
    });

    expect(curl).toContain(`What'\\''s 2 + 2?`);
  });
});

describe("TEST_MESSAGE", () => {
  it("is the greeting the command and the test both send", () => {
    expect(TEST_MESSAGE).toBe("Hello, how are you?");
  });
});
