import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";

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

function renderDialog(
  fetchImplementation: typeof fetch,
  hasSharedGatewayAccess = false,
) {
  vi.stubGlobal("fetch", vi.fn(fetchImplementation));
  render(
    <WorkspaceShellSession>
      <AgentsConnectDialog hasSharedGatewayAccess={hasSharedGatewayAccess} />
    </WorkspaceShellSession>,
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

  it("creates and reveals a user-scoped gateway key once", async () => {
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
            account_label: "duy*******@example.com",
            authorization: null,
            created_at: "2026-09-09T11:45:00Z",
            failure_message: null,
            id: "8c4b1408-a1f1-4f70-853f-2fd0916c2e25",
            plan: "max",
            provider: "claude",
            status: "connected",
            updated_at: "2026-09-09T11:45:00Z",
          },
        ]);
      }
      if (request.pathname === "/gateway-keys" && request.method === "POST") {
        return jsonResponse(
          {
            created_at: "2026-09-09T11:50:00Z",
            id: "50e1408f-78df-41e8-8026-d9719491fe6c",
            key: "hw_live_once-only-secret",
            last_four: "cret",
            last_used_at: null,
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
    await user.click(
      await screen.findByRole("button", { name: "Create gateway key" }),
    );

    expect(
      await screen.findByDisplayValue("hw_live_once-only-secret"),
    ).toBeVisible();
    expect(screen.getByText(/shown once/i)).toBeVisible();
  });

  it("lets an accepted pool member create a gateway key", async () => {
    renderDialog(async (input, init) => {
      const request = requestOptions(input, init);
      if (request.pathname === "/auth/session") {
        return jsonResponse({
          user: { id: "member-1", recovery_email: null, username: "member" },
        });
      }
      if (request.pathname === "/gateway-keys" && request.method === "POST") {
        return jsonResponse(
          {
            created_at: "2026-09-10T01:00:00Z",
            id: "50e1408f-78df-41e8-8026-d9719491fe6d",
            key: "hw_live_shared-account-key",
            last_four: "-key",
            last_used_at: null,
          },
          201,
        );
      }
      return jsonResponse([]);
    }, true);

    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect Agent" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Connect Agent" }));
    await user.click(
      await screen.findByRole("button", { name: "Create gateway key" }),
    );

    expect(
      await screen.findByDisplayValue("hw_live_shared-account-key"),
    ).toBeVisible();
  });
});
