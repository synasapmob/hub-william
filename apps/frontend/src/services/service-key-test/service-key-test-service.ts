import { z } from "zod";

import readPlaygroundStream from "@/services/playground/playground-stream";

import {
  serviceKeyTestRequest,
  type ServiceKeyTestInput,
} from "./service-key-test-request";

const GATEWAY_UNREACHABLE = "The gateway could not be reached.";

// The gateway's own errors carry `message`; an agent's carry `error.message`.
const errorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
  message: z.string().optional(),
});

export class ServiceKeyTestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface ServiceKeyTestOptions extends ServiceKeyTestInput {
  key: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export interface ServiceKeyTestResult {
  status: number;
  durationMs: number;
}

function statusMessage(status: number) {
  switch (status) {
    case 401:
      return "This key is not active. Paste a service key that has not been revoked.";
    case 402:
      return "The balance is too low for this request. Top up and try again.";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    case 502:
      return "The service has no capacity for this agent right now.";
    default:
      return `The gateway answered HTTP ${status}.`;
  }
}

class ServiceKeyTestService {
  /**
   * Send one message to the gateway with a service key, straight from the
   * browser, and stream the answer into `onDelta`. It is a real request: it is
   * charged like any other. The session cookie is not sent, so the key alone
   * is what is tried.
   */
  async run({
    key,
    onDelta,
    signal,
    ...input
  }: ServiceKeyTestOptions): Promise<ServiceKeyTestResult> {
    const { body, url } = serviceKeyTestRequest(input);
    const startedAt = performance.now();
    let response: Response;

    try {
      response = await globalThis.fetch(url, {
        body: JSON.stringify(body),
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;

      throw new ServiceKeyTestError(GATEWAY_UNREACHABLE);
    }

    if (!response.ok || !response.body) {
      const payload = errorSchema.safeParse(
        await response.json().catch(() => null),
      );
      const message = payload.success
        ? (payload.data.message ?? payload.data.error?.message)
        : undefined;

      throw new ServiceKeyTestError(
        message ?? statusMessage(response.status),
        response.status,
      );
    }

    await readPlaygroundStream({
      onDelta,
      provider: input.provider,
      signal,
      stream: response.body,
    });

    return {
      durationMs: Math.round(performance.now() - startedAt),
      status: response.status,
    };
  }
}

export const serviceKeyTestService = new ServiceKeyTestService();
