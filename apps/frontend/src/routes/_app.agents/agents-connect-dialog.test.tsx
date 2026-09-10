import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import createQueryClient from "@/utils/utils.query-client";

import AgentsConnectDialog from "./agents-connect-dialog";

interface ApiResponseOptions {
  method?: string;
  pathname: string;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestOptions(
  input: RequestInfo | URL,
  init?: RequestInit,
): ApiResponseOptions {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input));
  return {
    method: init?.method ?? request?.method ?? "GET",
    pathname: url.pathname,
  };
}

function renderDialog(fetchImplementation: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(fetchImplementation));
  render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceShellSession>
        <AgentsConnectDialog />
      </WorkspaceShellSession>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentsConnectDialog", () => {
  it("opens the official provider URL returned by the backend", async () => {
    const popup = {
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    renderDialog(async (input, init) => {
      const request = requestOptions(input, init);
      if (request.pathname === "/auth/session") {
        return jsonResponse({
          user: { id: "user-1", recovery_email: null, username: "syn" },
        });
      }
      if (request.pathname === "/agent-connections/start") {
        return jsonResponse(
          {
            account_label: null,
            authorization: {
              authorization_url:
                "https://claude.com/cai/oauth/authorize?code=true",
              expires_at: "2026-09-09T12:00:00Z",
              poll_after_seconds: 5,
              requires_callback_url: true,
              user_code: null,
            },
            created_at: "2026-09-09T11:45:00Z",
            failure_message: null,
            id: "8c4b1408-a1f1-4f70-853f-2fd0916c2e25",
            plan: null,
            provider: "claude",
            status: "pending",
            updated_at: "2026-09-09T11:45:00Z",
          },
          201,
        );
      }
      return jsonResponse([]);
    });

    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect Agent" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Connect Agent" }));
    await user.click(screen.getByRole("button", { name: /claude/i }));

    expect(window.open).toHaveBeenCalledWith(
      "about:blank",
      "hub-william-agent-connect",
      "popup,width=720,height=820",
    );
    await waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith(
        "https://claude.com/cai/oauth/authorize?code=true",
      ),
    );
    expect(popup.opener).toBeNull();
    expect(screen.getByLabelText("Callback URL or code")).toBeVisible();
  });

  it("keeps every connected account for the same provider available", async () => {
    renderDialog(async (input, init) => {
      const request = requestOptions(input, init);
      if (request.pathname === "/auth/session") {
        return jsonResponse({
          user: { id: "user-1", recovery_email: null, username: "syn" },
        });
      }
      if (request.pathname === "/agent-connections") {
        return jsonResponse([
          {
            account_label: "fir*******@example.com",
            authorization: null,
            created_at: "2026-09-09T11:45:00Z",
            failure_message: null,
            id: "8c4b1408-a1f1-4f70-853f-2fd0916c2e25",
            plan: "Plus",
            provider: "claude",
            status: "connected",
            updated_at: "2026-09-09T11:45:00Z",
          },
          {
            account_label: "sec*******@example.com",
            authorization: null,
            created_at: "2026-09-09T11:46:00Z",
            failure_message: null,
            id: "9d5c2519-b2f2-4f81-9640-3ae2027d3f36",
            plan: "K12",
            provider: "claude",
            status: "connected",
            updated_at: "2026-09-09T11:46:00Z",
          },
        ]);
      }
      return jsonResponse([]);
    });

    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect Agent" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Connect Agent" }));
    expect(await screen.findByText("2 connected")).toBeVisible();
    expect(screen.getByRole("button", { name: /claude/i })).toBeEnabled();
  });
});
