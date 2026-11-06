import type { AgentProviderId } from "@/services/agent/agent-types";

// The Playground sends the same instructions with every message.
const INSTRUCTIONS = "Answer the user's questions helpfully.";

// What a test says. It is fixed, so the command and the test send the same thing.
export const TEST_MESSAGE = "Hello, how are you?";

export interface ServiceKeyTestInput {
  origin: string;
  provider: AgentProviderId;
  model: string;
  message: string;
}

export interface ServiceKeyTestRequest {
  url: string;
  body: unknown;
}

/**
 * The request a client sends the gateway for one message: the route of the agent
 * and a body in the agent's own shape. These are the bodies the Playground sends,
 * so the same agents answer them.
 */
export function serviceKeyTestRequest({
  message,
  model,
  origin,
  provider,
}: ServiceKeyTestInput): ServiceKeyTestRequest {
  const base = `${origin.replace(/\/$/, "")}/gateway`;
  const input = [
    { role: "user", content: [{ type: "input_text", text: message }] },
  ];

  switch (provider) {
    case "claude":
      return {
        url: `${base}/claude/v1/messages`,
        body: {
          model,
          max_tokens: 4096,
          messages: [{ role: "user", content: message }],
          stream: true,
        },
      };

    case "gemini":
      return {
        url: `${base}/gemini/v1beta/models/${model.replace(/^models\//, "")}:streamGenerateContent`,
        body: { contents: [{ role: "user", parts: [{ text: message }] }] },
      };

    case "groq":
      return {
        url: `${base}/groq/v1/responses`,
        body: { model, input, stream: true, instructions: INSTRUCTIONS },
      };

    case "chatgpt":
      return {
        url: `${base}/openai/v1/responses`,
        body: {
          model,
          input,
          stream: true,
          store: false,
          instructions: INSTRUCTIONS,
        },
      };

    case "grok":
      return {
        url: `${base}/grok/v1/responses`,
        body: {
          model,
          input,
          stream: true,
          store: false,
          instructions: INSTRUCTIONS,
        },
      };

    case "deepseek":
      return {
        url: `${base}/deepseek/responses`,
        body: {
          model,
          input,
          stream: true,
          store: false,
          instructions: INSTRUCTIONS,
        },
      };
  }
}

/**
 * The same request as a `curl` command, to paste into a terminal. The body is
 * single-quoted, so a quote in the message is closed and reopened around itself.
 */
export function serviceKeyCurl(input: ServiceKeyTestInput & { key: string }) {
  const { body, url } = serviceKeyTestRequest(input);

  return [
    `curl -N ${url}`,
    `-H "Authorization: Bearer ${input.key}"`,
    `-H "Content-Type: application/json"`,
    `-d '${JSON.stringify(body).replaceAll("'", "'\\''")}'`,
  ].join(" \\\n  ");
}
