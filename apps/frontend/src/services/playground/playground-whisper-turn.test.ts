import { afterEach, describe, expect, it, vi } from "vitest";
import playgroundService from "./index";
import playgroundWhisperTurn, {
  type PlaygroundWhisperEvent,
  type PlaygroundWhisperTurnOptions,
} from "./playground-whisper-turn";

function options(
  provider: PlaygroundWhisperTurnOptions["provider"],
): PlaygroundWhisperTurnOptions {
  return {
    provider,
    model: "selected-chat-model",
    connectionId: "selected-account",
    organizationId: "selected-org",
    transcript: "Hello",
    messages: [],
    signal: new AbortController().signal,
    speech: {
      synthesize: vi.fn(async () => ({
        samples: new Float32Array(22050),
        sampleRate: 22050,
      })),
      dispose: vi.fn(),
    },
    onEvent: vi.fn(),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("Call Whisper text and local speech transport", () => {
  it.each(["chatgpt", "gemini", "claude", "deepseek", "grok", "groq"] as const)(
    "sends %s chat with the selected account and never calls the Groq speech endpoint",
    async (provider) => {
      const input = options(provider);
      const remoteSpeech = vi.spyOn(playgroundService, "groqTurn");
      const chat = vi
        .spyOn(playgroundService, "chat")
        .mockImplementation(async (request) => {
          request.onDelta("Hello! ");
          request.onDelta("How are you?");
          return { servedConnectionId: "selected-account" };
        });
      const result = await playgroundWhisperTurn.turn(input);
      expect(chat).toHaveBeenCalledOnce();
      expect(chat.mock.calls[0][0]).toMatchObject({
        provider,
        connectionId: "selected-account",
        organizationId: "selected-org",
        model: "selected-chat-model",
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(chat.mock.calls[0][0]).not.toHaveProperty("audio");
      expect(remoteSpeech).not.toHaveBeenCalled();
      expect(input.speech.synthesize).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        transcript: "Hello",
        reply: "Hello! How are you?",
        audio: [],
      });
      expect(input.onEvent).toHaveBeenLastCalledWith({ type: "done" });
    },
  );

  it("streams text immediately while speech is pending and bounds segments without spaces", async () => {
    const input = options("gemini");
    let release!: () => void;
    input.speech.synthesize = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { samples: new Float32Array(22050), sampleRate: 22050 };
    });
    vi.spyOn(playgroundService, "chat").mockImplementation(async (request) => {
      request.onDelta("a".repeat(240));
      return { servedConnectionId: null };
    });
    const pending = playgroundWhisperTurn.turn(input);
    await vi.waitFor(() =>
      expect(input.speech.synthesize).toHaveBeenCalledOnce(),
    );
    expect(input.onEvent).toHaveBeenCalledWith({
      type: "delta",
      text: "a".repeat(240),
    });
    expect(input.onEvent).not.toHaveBeenCalledWith({ type: "done" });
    release();
    await pending;
    expect(vi.mocked(input.speech.synthesize).mock.calls[0][0]).toHaveLength(
      240,
    );
  });

  it("aborts chat on local synthesis failure without replaying generation", async () => {
    const input = options("deepseek");
    input.speech.synthesize = vi
      .fn()
      .mockRejectedValue(new Error("Local voice failed"));
    const chat = vi
      .spyOn(playgroundService, "chat")
      .mockImplementation(async (request) => {
        request.onDelta("Hello.");
        return new Promise((_, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          ),
        );
      });
    await expect(playgroundWhisperTurn.turn(input)).rejects.toThrow(
      "Local voice failed",
    );
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it("ignores late audio and queued segments after interruption", async () => {
    const input = options("grok");
    const controller = new AbortController();
    input.signal = controller.signal;
    let release!: () => void;
    input.speech.synthesize = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { samples: new Float32Array(100), sampleRate: 22050 };
    });
    vi.spyOn(playgroundService, "chat").mockImplementation(async (request) => {
      request.onDelta("First. Second.");
      return { servedConnectionId: null };
    });
    const pending = playgroundWhisperTurn.turn(input);
    await vi.waitFor(() =>
      expect(input.speech.synthesize).toHaveBeenCalledOnce(),
    );
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(input.speech.synthesize).toHaveBeenCalledOnce();
    const events = vi
      .mocked(input.onEvent!)
      .mock.calls.map(([event]) => event as PlaygroundWhisperEvent);
    expect(
      events.some((event) => event.type === "audio" || event.type === "done"),
    ).toBe(false);
  });
});
