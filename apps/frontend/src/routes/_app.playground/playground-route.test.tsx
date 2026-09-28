import { StrictMode, useState } from "react";
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSessionContext from "@/components/workspace-shell/workspace-shell-session-context";
import agentPoolsService, { type AgentPool } from "@/services/agent-pools";
import organizationsService, {
  type OrganizationAgentDetails,
} from "@/services/organizations";
import playgroundService from "@/services/playground";
import playgroundWhisperTurnService from "@/services/playground/playground-whisper-turn";
import playgroundSpeechPreload from "@/services/playground/playground-speech-preload";
import playgroundVoiceService from "@/services/playground/playground-voice";
import providerCatalogue from "@/services/provider-catalogue";
import createQueryClient from "@/utils/utils.query-client";

import PlaygroundRoute from "./route";

vi.mock("@/services/playground", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/playground")>();
  return {
    ...original,
    default: {
      ...original.default,
      models: vi.fn(),
      chat: vi.fn(),
    },
  };
});

vi.mock("@/services/agent-pools", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/agent-pools")>();
  return { ...original, default: { ...original.default, list: vi.fn() } };
});
vi.mock("@/services/organizations", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/organizations")>();
  return {
    ...original,
    default: {
      ...original.default,
      list: vi.fn(),
      agents: vi.fn(),
    },
  };
});
const account = {
  id: "account-a",
  accountLabel: "My account",
  agent: "DeepSeek",
  owner: { username: "member" },
  members: [],
  requests: [],
  availability: { status: "active" },
} as unknown as AgentPool;
const openAuth = vi.fn();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(
    await screen.findByRole("option", {
      name:
        field === "Provider" ? new RegExp(`^${option} \\(\\d+\\)$`) : option,
    }),
  );
}

async function selectAccount(user: ReturnType<typeof userEvent.setup>) {
  await chooseOption(user, "Provider", "DeepSeek");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
      "My account",
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Provider model",
    ),
  );
}
interface HarnessProps {
  guest?: boolean;
  initialEntry?: string;
  queryClient?: QueryClient;
}
function Harness({
  guest = false,
  initialEntry = "/playground",
  queryClient: suppliedClient,
}: HarnessProps) {
  const [queryClient] = useState(() => suppliedClient ?? createQueryClient());
  const [signedIn, setSignedIn] = useState(!guest);
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <WorkspaceShellSessionContext.Provider
            value={{
              user: signedIn
                ? { id: "member", username: "member", recoveryEmail: null }
                : null,
              status: signedIn ? "authenticated" : "guest",
              openAuth,
              signOut: async () => setSignedIn(false),
            }}
          >
            <button
              type="button"
              onClick={() => setSignedIn((current) => !current)}
            >
              Change test session
            </button>
            <PlaygroundRoute />
          </WorkspaceShellSessionContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  vi.mocked(agentPoolsService.list).mockResolvedValue([account]);
  vi.mocked(organizationsService.list).mockResolvedValue([]);
  vi.mocked(organizationsService.agents).mockResolvedValue([]);
  vi.mocked(playgroundService.models).mockResolvedValue([
    { id: "live-model-id", name: "Provider model", modes: ["chat"] },
  ]);
  vi.mocked(playgroundService.chat).mockImplementation(async ({ onDelta }) => {
    onDelta("A real-service-shaped answer");
  });
});

describe("Playground conversation flow", () => {
  it.each(["chatgpt", "claude", "gemini", "grok", "deepseek"])(
    "defaults to a usable %s organization account and keeps a blocked selection pinned",
    async (provider) => {
      vi.mocked(organizationsService.list).mockResolvedValue([
        {
          id: "team",
          name: "Team",
          role: "member",
          description: null,
          createdAt: "2026-09-26",
        },
      ]);
      const shared: OrganizationAgentDetails = {
        id: "blocked",
        accountLabel: "Blocked AGY",
        ownerUsername: "owner",
        provider,
        availabilityStatus: "reauth_required",
        rateLimitedUntil: null,
        createdAt: "2026-09-26",
        plan: "Unknown",
        usage: [],
      };
      vi.mocked(organizationsService.agents).mockResolvedValue([
        shared,
        {
          ...shared,
          id: "ready",
          accountLabel: "Ready AGY",
          availabilityStatus: "active",
        },
      ]);
      const user = userEvent.setup();
      render(
        <Harness
          initialEntry={`/playground?organization=team&provider=${provider}`}
        />,
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Account")).toHaveTextContent("Ready AGY"),
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Model")).toHaveTextContent(
          "Provider model",
        ),
      );
      expect(playgroundService.models).toHaveBeenCalledWith(
        provider,
        "ready",
        expect.any(AbortSignal),
        "team",
      );
      await user.type(screen.getByLabelText("Message"), "Hello team");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await screen.findByText("Completed");
      expect(playgroundService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "ready",
          organizationId: "team",
        }),
      );
      vi.mocked(playgroundService.models).mockClear();
      vi.mocked(playgroundService.chat).mockClear();
      await chooseOption(user, "Account", "Blocked AGY");
      expect(screen.getByLabelText("Account")).toHaveTextContent("Blocked AGY");
      expect(
        screen.getByText(/Its owner must reconnect it in Agents/),
      ).toBeVisible();
      await user.type(screen.getByLabelText("Message"), "Do not send this");
      expect(screen.getByLabelText("Model")).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      expect(playgroundService.models).not.toHaveBeenCalled();
      expect(playgroundService.chat).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicitly linked blocked personal account selected until reconnect", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      {
        ...account,
        availability: { ...account.availability, status: "reauth_required" },
      },
      { ...account, id: "ready", accountLabel: "Ready account" },
    ]);
    const user = userEvent.setup();
    render(
      <Harness initialEntry="/playground?provider=deepseek&connection=account-a" />,
    );
    await screen.findByText(/Its owner must reconnect it in Agents/);
    expect(screen.getByLabelText("Account")).toHaveTextContent("My account");
    expect(playgroundService.models).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Message"), "Keep draft");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    vi.mocked(agentPoolsService.list).mockResolvedValue([account]);
    await user.click(
      screen.getByRole("button", { name: "Refresh account status" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "Provider model",
      ),
    );
    expect(
      screen.queryByText(/Its owner must reconnect it in Agents/),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("Keep draft");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("shows recovery guidance when all organization accounts need reconnect", async () => {
    vi.mocked(organizationsService.list).mockResolvedValue([
      {
        id: "team",
        name: "Team",
        role: "member",
        description: null,
        createdAt: "2026-09-26",
      },
    ]);
    vi.mocked(organizationsService.agents).mockResolvedValue([
      {
        id: "blocked",
        accountLabel: "Blocked AGY",
        ownerUsername: "owner",
        provider: "Gemini",
        availabilityStatus: "reauth_required",
        rateLimitedUntil: null,
        createdAt: "2026-09-26",
        plan: "Unknown",
        usage: [],
      },
    ]);
    render(
      <Harness initialEntry="/playground?organization=team&provider=gemini" />,
    );
    await screen.findByText(/Its owner must reconnect it in Agents/);
    expect(screen.getByLabelText("Account")).toHaveTextContent("Blocked AGY");
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(playgroundService.models).not.toHaveBeenCalled();
    expect(playgroundService.chat).not.toHaveBeenCalled();
  });

  it("zooms the existing chat, restores it with Escape or Exit Zoom, and never persists zoom", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await selectAccount(user);
    await user.type(screen.getByLabelText("Message"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const answer = await screen.findByText("A real-service-shaped answer");
    const composer = screen.getByLabelText("Message");
    const setup = screen.getByRole("heading", { name: "Setup" });
    const model = screen.getByLabelText("Model");
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Zoom Screen" }));
    expect(screen.getByLabelText("Message")).toBe(composer);
    expect(screen.getByText("A real-service-shaped answer")).toBe(answer);
    expect(composer).toHaveValue("Keep this draft");
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("heading", { name: "Setup" })).toBe(setup);
    expect(screen.getByLabelText("Model")).toBe(model);
    expect(model.closest("[inert]")).toBeNull();
    await user.click(model);
    expect(
      screen.getByRole("option", { name: "Provider model" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exit Zoom" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Zoom Screen" })).toHaveFocus();
    expect(document.body.style.overflow).not.toBe("hidden");
    await user.click(screen.getByRole("button", { name: "Zoom Screen" }));
    await user.click(screen.getByRole("button", { name: "Exit Zoom" }));
    expect(screen.getByLabelText("Message")).toBe(composer);
    expect(composer).toHaveValue("Keep this draft");
    await user.click(screen.getByRole("button", { name: "Zoom Screen" }));
    view.unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Zoom Screen" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Exit Zoom" }),
    ).not.toBeInTheDocument();
  });

  it("keeps setup cached across chat results, tab focus and reconnect, but honors account invalidation", async () => {
    const queryClient = createQueryClient();
    const user = userEvent.setup();
    render(<Harness queryClient={queryClient} />);
    await selectAccount(user);
    expect(agentPoolsService.list).toHaveBeenCalledTimes(1);
    expect(playgroundService.models).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText("Message"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Completed");
    vi.mocked(playgroundService.chat).mockRejectedValueOnce(
      new Error("This account is no longer available."),
    );
    await user.type(screen.getByLabelText("Message"), "Next question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This account is no longer available.",
    );
    try {
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      expect(agentPoolsService.list).toHaveBeenCalledTimes(1);
      expect(playgroundService.models).toHaveBeenCalledTimes(1);
      expect(organizationsService.list).toHaveBeenCalledTimes(1);
    } finally {
      focusManager.setFocused(undefined);
      onlineManager.setOnline(true);
    }

    vi.mocked(agentPoolsService.list).mockResolvedValue([]);
    await act(() =>
      queryClient.invalidateQueries({ queryKey: agentPoolsService.queryKey }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Account")).toBeDisabled(),
    );
    expect(agentPoolsService.list).toHaveBeenCalledTimes(2);
    expect(playgroundService.models).toHaveBeenCalledTimes(1);
  });

  it("filters models by mode, preserves the chosen account and chat draft, and cleans up an active call", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "ChatGPT" },
      {
        ...account,
        id: "account-b",
        agent: "ChatGPT",
        accountLabel: "Second account",
      },
    ]);
    vi.mocked(playgroundService.models).mockResolvedValue([
      { id: "gpt-6-sol", name: "GPT-6 Sol", modes: ["chat"] },
      { id: "gpt-live-1-codex", name: "Codex Voice", modes: ["voice"] },
    ]);
    const end = vi.fn();
    const start = vi
      .spyOn(playgroundVoiceService, "start")
      .mockImplementation(async (options) => {
        options.onStatus("connected");
        options.onTranscripts([
          { id: 1, role: "user", text: "Hello teacher", complete: true },
          {
            id: 2,
            role: "assistant",
            text: "Hello, how are you?",
            complete: true,
          },
        ]);
        return { end, mute: vi.fn(), camera: vi.fn() };
      });
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent("GPT-6 Sol"),
    );
    expect(screen.getByLabelText("Provider")).toHaveTextContent("ChatGPT (2)");
    expect(screen.getByLabelText("Account")).toHaveTextContent("My account");
    expect(screen.getByLabelText("Account")).not.toHaveTextContent("member");
    expect(screen.getByLabelText("Mode")).toHaveTextContent("Chat");
    expect(
      screen
        .getAllByRole("combobox")
        .map((element) => element.getAttribute("id")),
    ).toEqual([
      "playground-organization",
      "playground-mode",
      "playground-provider",
      "playground-account",
      "playground-model",
    ]);
    await user.click(screen.getByLabelText("Model"));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "GPT-6 Sol" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Codex Voice" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await chooseOption(user, "Account", "Second account");
    await user.type(screen.getByLabelText("Message"), "Keep my chat draft");
    await chooseOption(user, "Mode", "Call Live");
    expect(screen.getByLabelText("Account")).toHaveTextContent(
      "Second account",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "gpt-live-1-codex",
      ),
    );
    expect(screen.getByText("Ready to talk")).toBeVisible();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Provider"));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.queryByRole("option", { name: "Groq (0)" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ChatGPT (2)" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Model"));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.getByRole("option", { name: "gpt-live-1-codex" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "GPT-6 Sol" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByText("Camera is off")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start call" }));
    const transcript = screen.getByRole("log", { name: "Call transcript" });
    expect(await within(transcript).findByText("Hello teacher")).toBeVisible();
    expect(within(transcript).getByText("Hello, how are you?")).toBeVisible();
    expect(agentPoolsService.list).toHaveBeenCalledTimes(1);
    expect(playgroundService.models).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "End call" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Start call" }),
    ).not.toBeInTheDocument();
    expect(start.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        connectionId: "account-b",
        model: "gpt-live-1-codex",
        provider: "chatgpt",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Zoom Screen" }));
    expect(screen.getByRole("log", { name: "Call transcript" })).toBe(
      transcript,
    );
    expect(start).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Account")).toBeDisabled();
    expect(screen.getByLabelText("Mode").closest("[inert]")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("log", { name: "Call transcript" })).toBe(
      transcript,
    );
    expect(start.mock.calls[0][0].signal.aborted).toBe(false);
    expect(end).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Zoom Screen" }));
    await chooseOption(user, "Mode", "Chat");
    expect(screen.getByRole("button", { name: "Exit Zoom" })).toBeVisible();
    expect(start.mock.calls[0][0].signal.aborted).toBe(true);
    expect(end).toHaveBeenCalled();
    expect(screen.getByLabelText("Account")).toHaveTextContent(
      "Second account",
    );
    expect(screen.getByLabelText("Model")).toHaveTextContent("GPT-6 Sol");
    expect(screen.getByLabelText("Message")).toHaveValue("Keep my chat draft");
    expect(
      screen.queryByRole("log", { name: "Call transcript" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["Call Live", "call-live", "ChatGPT", "gpt-live-1-codex"],
    ["Call Whisper", "call-whisper", "Groq", "openai/gpt-oss-20b"],
  ] as const)(
    "retains %s, Voice and Camera through End and remount without starting automatically",
    async (label, storedMode, agent, model) => {
      vi.mocked(agentPoolsService.list).mockResolvedValue([
        { ...account, agent },
      ]);
      vi.mocked(playgroundService.models).mockResolvedValue([
        {
          id: model,
          name: model,
          modes: agent === "ChatGPT" ? ["voice"] : ["chat"],
        },
      ]);
      const start = vi
        .spyOn(playgroundVoiceService, "start")
        .mockImplementation(async (options) => {
          options.onStatus("connected");
          return {
            mute: vi.fn(),
            camera: vi.fn(),
            end: () => {
              options.onCamera(null);
              options.onStatus("ended");
            },
          };
        });
      const user = userEvent.setup();
      const view = render(<Harness />);
      await chooseOption(user, "Mode", label);
      expect(window.localStorage.getItem("hub.playground.mode")).toBe(
        storedMode,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Start call" }),
        ).toBeEnabled(),
      );
      await user.click(screen.getByRole("button", { name: "Voice" }));
      await user.click(screen.getByRole("button", { name: "Camera" }));
      await user.click(screen.getByRole("button", { name: "Start call" }));
      expect(start.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({ voiceEnabled: false, cameraEnabled: false }),
      );
      await user.click(screen.getByRole("button", { name: "End call" }));
      expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.getByRole("button", { name: "Camera" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      view.unmount();
      const restored = render(<Harness />);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Mode" }),
        ).toHaveTextContent(label),
      );
      expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.getByRole("button", { name: "Camera" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(start).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Start call" }),
        ).toBeEnabled(),
      );
      await user.click(screen.getByRole("button", { name: "Start call" }));
      expect(start.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({ voiceEnabled: false, cameraEnabled: false }),
      );
      await user.click(screen.getByRole("button", { name: "End call" }));
      await chooseOption(user, "Mode", "Chat");
      restored.unmount();
      render(<Harness />);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Mode" }),
        ).toHaveTextContent("Chat"),
      );
      expect(start).toHaveBeenCalledTimes(2);
    },
  );

  it("separates native and Whisper providers/models and ends the old call when changing call modes", async () => {
    const groqProfile = providerCatalogue.callProfile(
      "groq",
      "openai/gpt-oss-20b",
    )!;
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "ChatGPT" },
      {
        ...account,
        id: "groq-account",
        agent: "Groq",
        accountLabel: "Groq account",
      },
      { ...account, id: "gemini-account", agent: "Gemini" },
    ]);
    vi.mocked(playgroundService.models).mockImplementation(async (provider) =>
      provider === "chatgpt"
        ? [
            { id: "gpt-6-sol", name: "GPT-6 Sol", modes: ["chat"] },
            { id: "gpt-live-1-codex", name: "Native call", modes: ["voice"] },
            { id: "unknown-call", name: "Unknown call", modes: ["voice"] },
            {
              id: "wrong-kind",
              name: "Wrong kind",
              modes: ["voice"],
              call: {
                ...groqProfile,
                provider: "chatgpt",
                selector_model: "wrong-kind",
              },
            },
            {
              id: "wrong-provider",
              name: "Wrong provider",
              modes: ["voice"],
              call: {
                ...groqProfile,
                kind: "native_realtime",
                selector_model: "wrong-provider",
              },
            },
          ]
        : [
            {
              id: "openai/gpt-oss-20b",
              name: "GPT OSS 20B",
              modes: ["chat", "voice"],
              call: groqProfile,
            },
          ],
    );
    const end = vi.fn();
    const start = vi
      .spyOn(playgroundVoiceService, "start")
      .mockImplementation(async (options) => {
        options.onStatus("connected");
        return { end, mute: vi.fn(), camera: vi.fn() };
      });
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent("GPT-6 Sol"),
    );
    await user.click(screen.getByLabelText("Mode"));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Chat", "Call Live", "Call Whisper"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Provider"));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["ChatGPT (1)", "Gemini (1)", "Groq (1)"]);
    await user.keyboard("{Escape}");
    await chooseOption(user, "Mode", "Call Live");
    await user.click(screen.getByLabelText("Provider"));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["ChatGPT (1)"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Model"));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["gpt-live-1-codex"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    expect(start).toHaveBeenCalledOnce();
    await chooseOption(user, "Mode", "Call Whisper");
    expect(screen.getByLabelText("Model")).toHaveTextContent("gpt-6-sol");
    await chooseOption(user, "Provider", "Groq");
    expect(start.mock.calls[0][0].signal.aborted).toBe(true);
    expect(end).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "openai/gpt-oss-20b",
      ),
    );
    expect(screen.getByLabelText("Account")).toHaveTextContent("Groq account");
    await user.click(screen.getByLabelText("Provider"));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["ChatGPT (1)", "Gemini (1)", "Groq (1)"]);
    await user.keyboard("{Escape}");
    expect(start).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Start call" }));
    expect(start.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        provider: "groq",
        model: "openai/gpt-oss-20b",
        connectionId: "groq-account",
        callProfile: groqProfile,
      }),
    );
    await chooseOption(user, "Mode", "Chat");
    expect(end).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Account")).toHaveTextContent("Groq account");
    expect(screen.getByLabelText("Model")).toHaveTextContent("GPT OSS 20B");
    expect(agentPoolsService.list).toHaveBeenCalledOnce();
    expect(playgroundService.models).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ChatGPT", "Call Live", "call-live", "gpt-live-1-codex"],
    ["Groq", "Call Whisper", "call-whisper", "openai/gpt-oss-20b"],
    ["DeepSeek", "Call Whisper", "call-whisper", "deepseek-v4"],
    ["Gemini", "Call Whisper", "call-whisper", "gemini-chat"],
  ] as const)(
    "migrates legacy Call after %s account discovery without starting media",
    async (agent, label, storedMode, model) => {
      window.localStorage.setItem("hub.playground.mode", "voice");
      let resolveAccounts!: (accounts: AgentPool[]) => void;
      vi.mocked(agentPoolsService.list).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAccounts = resolve;
          }),
      );
      vi.mocked(playgroundService.models).mockResolvedValue([
        {
          id: model,
          name: model,
          modes: agent === "ChatGPT" ? ["voice"] : ["chat"],
        },
      ]);
      const start = vi.spyOn(playgroundVoiceService, "start");
      render(<Harness />);
      expect(window.localStorage.getItem("hub.playground.mode")).toBe("voice");
      expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
      await act(async () => resolveAccounts([{ ...account, agent }]));
      await waitFor(() =>
        expect(screen.getByLabelText("Model")).toHaveTextContent(model),
      );
      expect(screen.getByLabelText("Mode")).toHaveTextContent(label);
      expect(window.localStorage.getItem("hub.playground.mode")).toBe(
        storedMode,
      );
      expect(screen.getByRole("button", { name: "Start call" })).toBeEnabled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(["guest", "no accounts", "discovery error"])(
    "defers legacy Call migration with %s until an eligible account is known",
    async (state) => {
      window.localStorage.setItem("hub.playground.mode", "voice");
      if (state === "discovery error")
        vi.mocked(agentPoolsService.list).mockRejectedValueOnce(
          new Error("Accounts unavailable"),
        );
      else vi.mocked(agentPoolsService.list).mockResolvedValueOnce([]);
      vi.mocked(agentPoolsService.list).mockResolvedValue([
        { ...account, agent: "Groq" },
      ]);
      vi.mocked(playgroundService.models).mockResolvedValue([
        { id: "openai/gpt-oss-20b", name: "Groq call", modes: ["chat"] },
      ]);
      const client = createQueryClient();
      const start = vi.spyOn(playgroundVoiceService, "start");
      const user = userEvent.setup();
      render(<Harness guest={state === "guest"} queryClient={client} />);
      await waitFor(() =>
        expect(screen.getByLabelText("Provider")).toHaveTextContent(
          "No providers available",
        ),
      );
      expect(window.localStorage.getItem("hub.playground.mode")).toBe("voice");
      expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
      if (state === "guest")
        await user.click(
          screen.getByRole("button", { name: "Change test session" }),
        );
      else
        await act(async () => {
          await client.invalidateQueries({
            queryKey: agentPoolsService.queryKey,
          });
        });
      await waitFor(() =>
        expect(screen.getByLabelText("Model")).toHaveTextContent(
          "openai/gpt-oss-20b",
        ),
      );
      expect(screen.getByLabelText("Mode")).toHaveTextContent("Call Whisper");
      expect(window.localStorage.getItem("hub.playground.mode")).toBe(
        "call-whisper",
      );
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ChatGPT", "chatgpt"],
    ["Gemini", "gemini"],
    ["Claude", "claude"],
    ["DeepSeek", "deepseek"],
    ["Grok", "grok"],
    ["Groq", "groq"],
  ] as const)(
    "offers %s chat models in Call Whisper without native voice or Orpheus access",
    async (agent, provider) => {
      vi.mocked(agentPoolsService.list).mockResolvedValue([
        { ...account, agent },
      ]);
      vi.mocked(playgroundService.models).mockResolvedValue([
        {
          id: "selected-chat-model",
          name: "Friendly chat name",
          modes: ["chat"],
        },
        { id: "audio-only", name: "Audio only", modes: ["voice"] },
      ]);
      const preload = vi
        .spyOn(playgroundSpeechPreload, "preload")
        .mockReturnValue(vi.fn());
      const start = vi
        .spyOn(playgroundVoiceService, "start")
        .mockImplementation(async (options) => {
          options.onStatus("connected");
          return { end: vi.fn(), mute: vi.fn(), camera: vi.fn() };
        });
      const user = userEvent.setup();
      render(<Harness />);
      await waitFor(() =>
        expect(screen.getByLabelText("Account")).toHaveTextContent(
          "My account",
        ),
      );
      expect(preload).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      await chooseOption(user, "Mode", "Call Whisper");
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "selected-chat-model",
      );
      await user.click(screen.getByLabelText("Model"));
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["selected-chat-model"]);
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Start call" }));
      expect(start.mock.calls[0][0]).toMatchObject({
        provider,
        connectionId: "account-a",
        model: "selected-chat-model",
        mode: "call-whisper",
      });
      expect(playgroundService.models).toHaveBeenCalledOnce();
    },
  );

  it("keeps Start disabled when an account only advertises native audio models", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "ChatGPT" },
    ]);
    vi.mocked(playgroundService.models).mockResolvedValue([
      { id: "gpt-live-1-codex", name: "Native call", modes: ["voice"] },
    ]);
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByLabelText("Account")).toHaveTextContent("My account"),
    );
    await chooseOption(user, "Mode", "Call Whisper");
    expect(screen.getByLabelText("Provider")).toHaveTextContent("ChatGPT (1)");
    expect(screen.getByLabelText("Account")).toHaveTextContent("My account");
    expect(screen.getByLabelText("Model")).not.toHaveTextContent(
      "gpt-live-1-codex",
    );
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    expect(playgroundService.models).toHaveBeenCalledOnce();
  });

  it("keeps the Groq account while switching between chat and the locally transcribed call", async () => {
    const sendTurn = vi
      .spyOn(playgroundWhisperTurnService, "turn")
      .mockResolvedValue({ transcript: "Hello", reply: "Hi", audio: [] });
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "Groq" },
    ]);
    vi.mocked(playgroundService.models).mockResolvedValue([
      { id: "qwen/qwen3.8-27b", name: "qwen/qwen3.8-27b", modes: ["chat"] },
      {
        id: "openai/gpt-oss-20b",
        name: "openai/gpt-oss-20b",
        modes: ["voice"],
      },
    ]);
    const start = vi
      .spyOn(playgroundVoiceService, "start")
      .mockImplementation(async (options) => {
        options.onStatus("connected");
        options.onPhase?.("listening");
        return { end: vi.fn(), mute: vi.fn(), camera: vi.fn() };
      });
    const user = userEvent.setup();
    render(<Harness />);
    await chooseOption(user, "Provider", "Groq");
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "qwen/qwen3.8-27b",
      ),
    );
    await chooseOption(user, "Mode", "Call Whisper");
    expect(screen.getByLabelText("Provider")).toHaveTextContent("Groq (1)");
    expect(screen.getByLabelText("Account")).toHaveTextContent("My account");
    expect(screen.getByLabelText("Model")).toHaveTextContent(
      "qwen/qwen3.8-27b",
    );
    await user.click(screen.getByRole("button", { name: "Start call" }));
    expect(await screen.findByText("Ready to talk")).toBeVisible();
    // Connection can finish before the preferred camera permission resolves.
    const cameraButton = screen.getByRole("button", { name: "Camera" });
    expect(cameraButton).toHaveAttribute("aria-pressed", "true");
    await user.click(cameraButton);
    expect((await start.mock.results[0].value).camera).toHaveBeenCalledWith(
      false,
    );
    const callbacks = start.mock.calls[0][0];
    const turn = {
      provider: "groq" as const,
      speech: { synthesize: vi.fn(), dispose: vi.fn() },
      connectionId: "account-a",
      model: "qwen/qwen3.8-27b",
      transcript: "Hello",
      messages: [],
      signal: callbacks.signal,
    };
    await act(async () => {
      await callbacks.sendTurn?.(turn);
      await callbacks.sendTurn?.(turn);
    });
    sendTurn.mockRejectedValueOnce(new Error("Groq rate limit reached."));
    await act(async () => {
      await expect(callbacks.sendTurn?.(turn)).rejects.toThrow(
        "Groq rate limit reached.",
      );
    });
    expect(sendTurn).toHaveBeenCalledTimes(3);
    expect(agentPoolsService.list).toHaveBeenCalledTimes(1);
    expect(playgroundService.models).toHaveBeenCalledTimes(1);
    act(() => callbacks.onInputLevel?.(0.1));
    expect(screen.getByRole("status")).toHaveTextContent("Speaking");
    act(() => {
      callbacks.onInputActive?.(true);
      callbacks.onInputLevel?.(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Speaking");
    const bars = screen.getByRole("status").querySelectorAll("span[style]");
    expect(bars).toHaveLength(7);
    for (const bar of bars) expect(bar).toHaveStyle({ height: "12%" });
    act(() => {
      callbacks.onInputActive?.(false);
      callbacks.onPhase?.("thinking");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for BOT…");
    act(() => callbacks.onPhase?.("listening"));
    await user.click(screen.getByRole("button", { name: "Voice" }));
    expect(screen.getByRole("status")).toHaveTextContent("Microphone off");
    act(() => {
      callbacks.onInputLevel?.(0);
      callbacks.onPhase?.("thinking");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for BOT…");
    act(() => callbacks.onPhase?.("speaking"));
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    act(() => callbacks.onStatus("ending"));
    expect(screen.getByRole("status")).toHaveTextContent("Ending call…");
    expect(
      screen.queryByRole("button", { name: "Start call" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End call" })).toBeDisabled();
    act(() => callbacks.onStatus("ended"));
    expect(screen.getByRole("status")).toHaveTextContent("Call ended");
    expect(agentPoolsService.list).toHaveBeenCalledTimes(1);
    expect(playgroundService.models).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        provider: "groq",
        model: "qwen/qwen3.8-27b",
        connectionId: "account-a",
        sendTurn: expect.any(Function),
      }),
    );
    await chooseOption(user, "Mode", "Chat");
    expect(start.mock.calls[0][0].signal.aborted).toBe(true);
    expect(screen.getByLabelText("Model")).toHaveTextContent(
      "qwen/qwen3.8-27b",
    );
  });

  it.each(["Call Live"])(
    "hides providers without accessible %s accounts and restores chat providers",
    async (label) => {
      const start = vi.spyOn(playgroundVoiceService, "start");
      const user = userEvent.setup();
      render(<Harness />);
      await selectAccount(user);
      await chooseOption(user, "Mode", label);
      expect(screen.getByLabelText("Provider")).toHaveTextContent(
        "No providers available",
      );
      expect(screen.getByLabelText("Provider")).toBeDisabled();
      expect(screen.getAllByText("Sign in to continue")).toHaveLength(2);
      expect(screen.getByLabelText("Account")).toHaveTextContent(
        "Sign in to continue",
      );
      expect(screen.getByLabelText("Account")).toBeDisabled();
      expect(screen.getByLabelText("Model")).toBeDisabled();
      expect(screen.getByText("Ready to talk")).toBeVisible();
      expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
      expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
      await user.click(screen.getByLabelText("Provider"));
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(playgroundService.models).toHaveBeenCalledTimes(1);
      await chooseOption(user, "Mode", "Chat");
      await user.click(screen.getByLabelText("Provider"));
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(
        screen.getByRole("option", { name: "DeepSeek (1)" }),
      ).toBeVisible();
      expect(start).not.toHaveBeenCalled();
      expect(playgroundService.models).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(playgroundService.models)
          .mock.calls.every(
            ([provider, id]) => provider === "deepseek" && id === "account-a",
          ),
      ).toBe(true);
    },
  );

  it("keeps Call selected during account discovery and does not substitute a chat-only model", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "ChatGPT" },
      {
        ...account,
        agent: "ChatGPT",
        id: "account-b",
        accountLabel: "Second account",
      },
    ]);
    let resolveModels:
      | ((models: Awaited<ReturnType<typeof playgroundService.models>>) => void)
      | undefined;
    vi.mocked(playgroundService.models).mockImplementation(
      async (_provider, id) => {
        if (id === "account-b")
          return new Promise((resolve) => {
            resolveModels = resolve;
          });
        return [
          { id: "chat-only", name: "Chat only", modes: ["chat"] },
          { id: "gpt-live-1-codex", name: "Codex Voice", modes: ["voice"] },
        ];
      },
    );
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent("Chat only"),
    );
    await chooseOption(user, "Mode", "Call Live");
    expect(screen.getByRole("button", { name: "Start call" })).toBeEnabled();
    await chooseOption(user, "Account", "Second account");
    expect(screen.getByLabelText("Mode")).toHaveTextContent("Call Live");
    expect(screen.getByLabelText("Model")).toHaveTextContent("Loading models");
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    await act(async () =>
      resolveModels?.([
        { id: "chat-only", name: "Chat only", modes: ["chat"] },
      ]),
    );
    expect(
      screen.queryByText("This account has no call models available."),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "No call models available",
      ),
    );
    expect(screen.getByLabelText("Mode")).toHaveTextContent("Call Live");
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    await chooseOption(user, "Account", "My account");
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "gpt-live-1-codex",
      ),
    );
    expect(screen.getByLabelText("Mode")).toHaveTextContent("Call Live");
    expect(screen.getByRole("button", { name: "Start call" })).toBeEnabled();
  });

  it.each(["Call Live", "Call Whisper"])(
    "lets guests explore %s without account or microphone access",
    async (label) => {
      const start = vi.spyOn(playgroundVoiceService, "start");
      const user = userEvent.setup();
      render(<Harness guest />);
      await chooseOption(user, "Mode", label);
      expect(screen.getByText("Ready to talk")).toBeVisible();
      expect(
        screen.queryByText("Sign in and choose an account to start a call."),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Provider")).toHaveTextContent(
        "No providers available",
      );
      expect(screen.getByLabelText("Provider")).toBeDisabled();
      expect(screen.getAllByText("Sign in to continue")).toHaveLength(2);
      expect(screen.getByLabelText("Account")).toBeDisabled();
      expect(screen.getByLabelText("Model")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
      expect(playgroundService.models).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("shows model discovery errors in Call and retries without changing mode", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "ChatGPT" },
    ]);
    vi.mocked(playgroundService.models)
      .mockRejectedValueOnce(new Error("Models could not be loaded."))
      .mockResolvedValue([
        { id: "gpt-live-1-codex", name: "Codex Voice", modes: ["voice"] },
      ]);
    const user = userEvent.setup();
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Models could not be loaded.",
    );
    await chooseOption(user, "Mode", "Call Live");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Models could not be loaded.",
    );
    expect(screen.getByText("Ready to talk")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start call" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry loading" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "gpt-live-1-codex",
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mode")).toHaveTextContent("Call Live");
    expect(screen.getByRole("button", { name: "Start call" })).toBeEnabled();
  });

  it("keeps a guest draft through authentication and loads only accessible models", async () => {
    const user = userEvent.setup();
    render(<Harness guest />);
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByLabelText("Account")).toBeDisabled();
    expect(screen.getAllByText("Sign in to continue")).toHaveLength(2);
    const composer = screen.getByRole("group", { name: "Message composer" });
    expect(
      within(composer).getByRole("textbox", { name: "Message" }),
    ).toBeVisible();
    expect(
      within(composer).getByRole("button", { name: "Upload files" }),
    ).toBeVisible();
    expect(
      within(composer).getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Explain how an AI gateway works" }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Message"), "Keep this question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(openAuth).toHaveBeenCalledOnce();
    expect(playgroundService.chat).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Change test session" }),
    );
    await selectAccount(user);
    expect(screen.getByLabelText("Message")).toHaveValue("Keep this question");
    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    expect(
      screen.queryByRole("option", { name: "ChatGPT (0)" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "DeepSeek (1)" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      await screen.findByText("A real-service-shaped answer"),
    ).toBeVisible();
  });

  it("sends completed history on the next turn and clears it for a new conversation", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    await user.type(screen.getByLabelText("Message"), "First question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Completed");
    await user.type(screen.getByLabelText("Message"), "Follow up");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(playgroundService.chat).toHaveBeenCalledTimes(2),
    );
    expect(
      vi.mocked(playgroundService.chat).mock.calls[1][0].connectionId,
    ).toBe("account-a");
    expect(vi.mocked(playgroundService.chat).mock.calls[1][0].messages).toEqual(
      [
        { role: "user", content: "First question", attachments: [] },
        { role: "assistant", content: "A real-service-shaped answer" },
        { role: "user", content: "Follow up", attachments: [] },
      ],
    );
    await user.click(screen.getByRole("button", { name: "New Chat" }));
    expect(screen.queryByText("First question")).not.toBeInTheDocument();
    expect(screen.getByText("What would you like to try?")).toBeVisible();
  });

  it("stops a pending request, preserves partial text, and excludes it from follow-up context", async () => {
    vi.mocked(playgroundService.chat).mockImplementationOnce(
      ({ signal, onDelta }) =>
        new Promise((_, reject) => {
          onDelta("Partial answer");
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true },
          );
        }),
    );
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    await user.type(screen.getByLabelText("Message"), "My question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Partial answer")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(
      await screen.findByText("Stopped · Incomplete response"),
    ).toBeVisible();
    expect(agentPoolsService.list).toHaveBeenCalledTimes(1);
    expect(playgroundService.models).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Message")).toHaveValue("My question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(playgroundService.chat).toHaveBeenCalledTimes(2),
    );
    expect(
      vi.mocked(playgroundService.chat).mock.calls[1][0].connectionId,
    ).toBe("account-a");
    expect(vi.mocked(playgroundService.chat).mock.calls[1][0].messages).toEqual(
      [{ role: "user", content: "My question", attachments: [] }],
    );
  });

  it("cancels in-flight work and removes conversation data on logout", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(playgroundService.chat).mockImplementationOnce(
      ({ signal, onDelta }) =>
        new Promise((_, reject) => {
          requestSignal = signal;
          onDelta("Private answer");
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true },
          );
        }),
    );
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    await user.type(screen.getByLabelText("Message"), "Private question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Private answer");
    await user.click(
      screen.getByRole("button", { name: "Change test session" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(screen.queryByText("Private answer")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("keeps selection unavailable without an account and does not send requests", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([]);
    render(<Harness />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Account" }),
      ).toHaveTextContent("Sign in to continue"),
    );
    expect(screen.getByLabelText("Account")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(
      screen.queryByText(
        "Choose an account you own or a pool you have joined.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Manage access in Agents" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(playgroundService.chat).not.toHaveBeenCalled();
  });

  it("selects the first accessible account for each provider and keeps a manual choice", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      {
        ...account,
        id: "chatgpt-first",
        agent: "ChatGPT",
        accountLabel: "ChatGPT account",
      },
      {
        ...account,
        id: "gemini-first",
        agent: "Gemini",
        accountLabel: "First Gemini account",
      },
      {
        ...account,
        id: "gemini-blocked",
        agent: "Gemini",
        owner: { ...account.owner, username: "someone-else" },
      },
      {
        ...account,
        id: "gemini-second",
        agent: "Gemini",
        accountLabel: "Second Gemini account",
      },
      {
        ...account,
        id: "grok-blocked",
        agent: "Grok",
        owner: { ...account.owner, username: "someone-else" },
      },
    ]);
    const user = userEvent.setup();
    render(<Harness />);

    const selectedAccount = screen.getByRole("combobox", { name: "Account" });
    await waitFor(() =>
      expect(selectedAccount).toHaveTextContent("ChatGPT account"),
    );
    expect(playgroundService.models).toHaveBeenCalledWith(
      "chatgpt",
      "chatgpt-first",
      expect.any(AbortSignal),
      undefined,
    );

    await chooseOption(user, "Provider", "Gemini");
    await waitFor(() =>
      expect(selectedAccount).toHaveTextContent("First Gemini account"),
    );
    await user.click(selectedAccount);
    expect(
      screen.queryByRole("option", { name: /someone-else/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "Provider model",
      ),
    );
    await user.type(screen.getByLabelText("Message"), "Hello Gemini");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Completed");
    expect(playgroundService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gemini",
        connectionId: "gemini-first",
      }),
    );

    await chooseOption(user, "Account", "Second Gemini account");
    expect(selectedAccount).toHaveTextContent("Second Gemini account");
    await user.type(screen.getByLabelText("Message"), "Keep my choice");
    expect(selectedAccount).toHaveTextContent("Second Gemini account");

    await user.click(screen.getByLabelText("Provider"));
    expect(
      screen.queryByRole("option", { name: /Grok/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gemini (2)" })).toBeVisible();
    await user.keyboard("{Escape}");
    await chooseOption(user, "Provider", "ChatGPT");
    expect(selectedAccount).toHaveTextContent("ChatGPT account");
    await chooseOption(user, "Provider", "Gemini");
    await waitFor(() =>
      expect(selectedAccount).toHaveTextContent("First Gemini account"),
    );
  });

  it("sends on Enter, inserts a newline with Shift+Enter, and lists only owned or joined accounts", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      account,
      {
        ...account,
        id: "blocked",
        owner: { ...account.owner, username: "someone-else" },
      },
      {
        ...account,
        id: "joined",
        accountLabel: "Shared account",
        owner: { ...account.owner, username: "pool-owner" },
        members: [{ ...account.owner, username: "member" }],
      },
    ]);
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    expect(
      screen.queryByRole("option", { name: /someone-else/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Shared account" }),
    ).toBeEnabled();
    await user.click(screen.getByRole("option", { name: "Shared account" }));
    await user.type(
      screen.getByLabelText("Message"),
      "First line{Shift>}{Enter}{/Shift}Second line",
    );
    expect(playgroundService.chat).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await screen.findByText("Completed");
    expect(
      vi.mocked(playgroundService.chat).mock.calls[0][0].messages[0].content,
    ).toBe("First line\nSecond line");
    expect(
      vi.mocked(playgroundService.chat).mock.calls[0][0].connectionId,
    ).toBe("joined");
  });

  it("shows a failed request as the assistant message without a composer error box", async () => {
    vi.mocked(playgroundService.chat).mockRejectedValueOnce(
      new Error("The provider rejected this request."),
    );
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    await user.type(screen.getByLabelText("Message"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const turn = await screen.findByRole("article");
    expect(within(turn).getByText("Hello")).toBeVisible();
    expect(
      await within(turn).findByText("The provider rejected this request."),
    ).toBeVisible();
    expect(within(turn).getByRole("alert")).toHaveTextContent(
      "The provider rejected this request.",
    );
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(
      within(
        screen.getByRole("group", { name: "Message composer" }),
      ).queryByRole("alert"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No answer received.")).not.toBeInTheDocument();
  });

  it("ignores an empty draft without a validation message or invalid styling", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    const message = screen.getByRole("textbox", { name: "Message" });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    await user.type(message, "   {enter}");
    expect(message).toHaveValue("   ");
    expect(send).toBeDisabled();
    await user.clear(message);
    expect(send).toBeDisabled();
    expect(message).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("What would you like to try?")).toBeVisible();
    expect(playgroundService.chat).not.toHaveBeenCalled();
  });

  it("keeps the introduction visible when an account has no models", async () => {
    vi.mocked(playgroundService.models).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<Harness />);
    await chooseOption(user, "Provider", "DeepSeek");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Account" }),
      ).toHaveTextContent("My account"),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "No models available",
      ),
    );
    expect(screen.getByText("What would you like to try?")).toBeVisible();
    expect(screen.getByLabelText("Model")).toBeDisabled();
  });

  it("explains an empty current Claude lineup in the model control", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "Claude" },
    ]);
    vi.mocked(playgroundService.models).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<Harness />);
    await chooseOption(user, "Provider", "Claude");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "No current models available",
      ),
    );
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByText("What would you like to try?")).toBeVisible();
  });

  it("uploads real text bytes and sends the attachment without a typed prompt", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await selectAccount(user);
    const file = new File(["A document to summarize"], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () =>
        new TextEncoder().encode("A document to summarize").buffer,
    });
    await user.upload(screen.getByLabelText("Attach files"), file);
    await screen.findByRole("button", { name: "Remove notes.txt" });
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Completed");
    expect(vi.mocked(playgroundService.chat).mock.calls[0][0].messages).toEqual(
      [
        {
          role: "user",
          content: "",
          attachments: [
            {
              kind: "text",
              name: "notes.txt",
              text: "A document to summarize",
            },
          ],
        },
      ],
    );
  });

  it("uses only agents shared with the selected organization and attributes its request", async () => {
    vi.mocked(agentPoolsService.list).mockResolvedValue([
      { ...account, agent: "Groq" },
    ]);
    const organizationId = "11111111-1111-4111-8111-111111111111";
    vi.mocked(organizationsService.list).mockResolvedValue([
      {
        createdAt: "2026-09-23T00:00:00Z",
        description: null,
        id: organizationId,
        name: "Team Mây",
        role: "member",
      },
    ]);
    vi.mocked(organizationsService.agents).mockResolvedValue([
      {
        accountLabel: "Team account",
        availabilityStatus: "active",
        createdAt: "2026-09-23T00:00:00Z",
        id: "shared-account",
        ownerUsername: "owner",
        plan: "API",
        provider: "deepseek",
        rateLimitedUntil: null,
        usage: [],
      } satisfies OrganizationAgentDetails,
    ]);
    const user = userEvent.setup();
    render(<Harness />);

    await waitFor(() => expect(organizationsService.list).toHaveBeenCalled());
    await chooseOption(user, "Organization", "Team Mây");
    await chooseOption(user, "Provider", "DeepSeek");
    await user.click(screen.getByLabelText("Provider"));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "DeepSeek (1)" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Groq/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Account" }),
      ).toHaveTextContent("Team account"),
    );
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    expect(
      screen.queryByRole("option", { name: "My account" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(playgroundService.models).toHaveBeenCalledWith(
        "deepseek",
        "shared-account",
        expect.any(AbortSignal),
        organizationId,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "Provider model",
      ),
    );
    await user.type(screen.getByLabelText("Message"), "Hello team");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Completed");
    expect(playgroundService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "shared-account",
        organizationId,
      }),
    );
    expect(organizationsService.agents).toHaveBeenCalledTimes(1);
  });
});
