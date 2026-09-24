import { StrictMode, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSessionContext from "@/components/workspace-shell/workspace-shell-session-context";
import agentPoolsService, { type AgentPool } from "@/services/agent-pools";
import organizationsService, {
  type OrganizationAgentDetails,
} from "@/services/organizations";
import playgroundService from "@/services/playground";
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
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function selectAccount(user: ReturnType<typeof userEvent.setup>) {
  await chooseOption(user, "Provider", "DeepSeek");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
      "My account · member",
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
}
function Harness({ guest = false }: HarnessProps) {
  const [queryClient] = useState(createQueryClient);
  const [signedIn, setSignedIn] = useState(!guest);
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
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
  vi.clearAllMocks();
  vi.mocked(agentPoolsService.list).mockResolvedValue([account]);
  vi.mocked(organizationsService.list).mockResolvedValue([]);
  vi.mocked(organizationsService.agents).mockResolvedValue([]);
  vi.mocked(playgroundService.models).mockResolvedValue([
    { id: "live-model-id", name: "Provider model" },
  ]);
  vi.mocked(playgroundService.chat).mockImplementation(async ({ onDelta }) => {
    onDelta("A real-service-shaped answer");
  });
});

describe("Playground conversation flow", () => {
  it("keeps a guest draft through authentication and loads only accessible models", async () => {
    const user = userEvent.setup();
    render(<Harness guest />);
    expect(screen.getByLabelText("Provider")).toBeEnabled();
    expect(screen.getByLabelText("Account")).toBeDisabled();
    expect(screen.getByText("Sign in to choose an account")).toBeVisible();
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
    expect(screen.getByRole("option", { name: "ChatGPT" })).toBeInTheDocument();
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
      ).toHaveTextContent("No accounts available"),
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
    ]);
    const user = userEvent.setup();
    render(<Harness />);

    const selectedAccount = screen.getByRole("combobox", { name: "Account" });
    await waitFor(() =>
      expect(selectedAccount).toHaveTextContent("ChatGPT account · member"),
    );
    expect(playgroundService.models).toHaveBeenCalledWith(
      "chatgpt",
      "chatgpt-first",
      expect.any(AbortSignal),
      undefined,
    );

    await chooseOption(user, "Provider", "Gemini");
    await waitFor(() =>
      expect(selectedAccount).toHaveTextContent(
        "First Gemini account · member",
      ),
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

    await chooseOption(user, "Account", "Second Gemini account · member");
    expect(selectedAccount).toHaveTextContent("Second Gemini account · member");
    await user.type(screen.getByLabelText("Message"), "Keep my choice");
    expect(selectedAccount).toHaveTextContent("Second Gemini account · member");

    await chooseOption(user, "Provider", "Grok");
    expect(selectedAccount).toHaveTextContent("No accounts available");
    expect(selectedAccount).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    await chooseOption(user, "Provider", "Gemini");
    await waitFor(() =>
      expect(selectedAccount).toHaveTextContent(
        "First Gemini account · member",
      ),
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
      screen.getByRole("option", { name: "Shared account · pool-owner" }),
    ).toBeEnabled();
    await user.click(
      screen.getByRole("option", { name: "Shared account · pool-owner" }),
    );
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
      ).toHaveTextContent("My account · member"),
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
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Account" }),
      ).toHaveTextContent("Team account · owner"),
    );
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    expect(
      screen.queryByRole("option", { name: "My account · member" }),
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
  });
});
