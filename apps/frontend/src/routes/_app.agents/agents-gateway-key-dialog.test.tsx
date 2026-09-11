import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import createQueryClient from "@/utils/utils.query-client";

import AgentsGatewayKeyDialog from "./agents-gateway-key-dialog";

interface ApiRequest {
  method: string;
  pathname: string;
}

function requestFrom(input: RequestInfo | URL, init?: RequestInit): ApiRequest {
  const request = input instanceof Request ? input : null;
  return {
    method: init?.method ?? request?.method ?? "GET",
    pathname: new URL(request?.url ?? String(input)).pathname,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsGatewayKeyDialog", () => {
  it("creates, reveals once, lists masked keys, and revokes them", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init);
        if (request.pathname === "/auth/session") {
          return jsonResponse({
            user: { id: "user-1", recovery_email: null, username: "syn" },
          });
        }
        if (request.pathname === "/gateway-keys" && request.method === "GET") {
          return jsonResponse([
            {
              created_at: "2026-09-09T11:40:00Z",
              id: "40d0307e-67ce-40d7-8015-c8608380ed5b",
              last_four: "abcd",
              last_used_at: null,
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
        if (
          request.pathname ===
            "/gateway-keys/50e1408f-78df-41e8-8026-d9719491fe6c" &&
          request.method === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse({ message: "Not found" }, 404);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <QueryClientProvider client={createQueryClient()}>
          <WorkspaceShellSession>
            <AgentsGatewayKeyDialog />
          </WorkspaceShellSession>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Gateway Key" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Gateway Key" }));

    expect(
      await screen.findByRole("heading", { name: "Gateway API key" }),
    ).toBeVisible();
    expect(await screen.findByText("1 active")).toBeVisible();
    expect(screen.getByText("hw_live_********abcd")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Tools → Gateway" }),
    ).toHaveAttribute("href", "/tools?node=gateway");

    await user.click(
      screen.getByRole("button", { name: "Create gateway key" }),
    );

    expect(
      await screen.findByDisplayValue("hw_live_once-only-secret"),
    ).toBeVisible();
    expect(screen.getByText("2 active")).toBeVisible();
    const createdRow = screen.getByText("hw_live_********cret").closest("li");
    expect(createdRow).not.toBeNull();
    await user.click(
      within(createdRow!).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByText("hw_live_********cret"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByDisplayValue("hw_live_once-only-secret"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeVisible();
  });
});
