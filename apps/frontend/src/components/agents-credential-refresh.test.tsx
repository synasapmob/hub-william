import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentConnectionServiceError,
  type AgentConnection,
} from "@/services/agent-connections";
import createQueryClient from "@/utils/utils.query-client";

import AgentsCredentialRefresh from "./agents-credential-refresh";

const refreshedConnection: AgentConnection = {
  accountLabel: "ui-account-A",
  authorization: null,
  availabilityStatus: "active",
  createdAt: "2026-09-29T00:00:00Z",
  failureMessage: null,
  id: "connection-a",
  plan: "API",
  provider: "deepseek",
  status: "connected",
  updatedAt: "2026-09-29T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentsCredentialRefresh", () => {
  it("replaces an earlier success with the outcome of a failed retry", async () => {
    const popup = {
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const onRefresh = vi
      .fn<() => Promise<AgentConnection>>()
      .mockResolvedValueOnce(refreshedConnection)
      .mockRejectedValueOnce(
        new AgentConnectionServiceError("DeepSeek is temporarily unavailable."),
      );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <AgentsCredentialRefresh
          disabled={false}
          onRefresh={onRefresh}
          onRefreshComplete={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText("Provider credential refreshed"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(
      screen.getByText("DeepSeek is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Provider credential refreshed"),
    ).not.toBeInTheDocument();
  });
});
