import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import organizationsService, {
  type OrganizationInvitation,
} from "@/services/organizations";
import createQueryClient from "@/utils/utils.query-client";

import WorkspaceShellNotifications from "./workspace-shell-notifications";
import WorkspaceShellSessionContext from "./workspace-shell-session-context";

const userId = "11111111-1111-4111-8111-111111111111";
const invitations: OrganizationInvitation[] = [
  {
    createdAt: "2026-09-25T00:00:00Z",
    id: "66666666-6666-4666-8666-666666666666",
    invitedByUsername: "linh",
    organizationId: "77777777-7777-4777-8777-777777777777",
    organizationName: "Team Gió",
  },
  {
    createdAt: "2026-09-26T00:00:00Z",
    id: "88888888-8888-4888-8888-888888888888",
    invitedByUsername: null,
    organizationId: "99999999-9999-4999-8999-999999999999",
    organizationName: "Team Sông",
  },
];

afterEach(() => vi.restoreAllMocks());

function Location() {
  const location = useLocation();
  return (
    <output>
      Location: {location.pathname}
      {location.search}
    </output>
  );
}

interface RenderNotificationsOptions {
  initialEntry?: string;
  onNavigate?: () => void;
}

function renderNotifications({
  initialEntry = "/tools",
  onNavigate,
}: RenderNotificationsOptions = {}) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceShellSessionContext.Provider
        value={{
          openAuth: vi.fn(),
          signOut: vi.fn(),
          status: "authenticated",
          user: { id: userId, recoveryEmail: null, username: "minh" },
        }}
      >
        <MemoryRouter initialEntries={[initialEntry]}>
          <WorkspaceShellNotifications onNavigate={onNavigate} />
          <Location />
        </MemoryRouter>
      </WorkspaceShellSessionContext.Provider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function invitationsObserver(queryClient: QueryClient) {
  return queryClient.getQueryCache().find({
    queryKey: [...organizationsService.queryKey, "invitations", userId],
  })?.observers[0];
}

describe("Invitation notifications", () => {
  it("counts pending invitations on the bell and lists them", async () => {
    vi.spyOn(organizationsService, "invitations").mockResolvedValue(
      invitations,
    );

    renderNotifications();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Notifications, 2 pending invitations",
      }),
    );

    expect(
      screen.getByRole("link", { name: /Invitation to Team Gió/ }),
    ).toHaveTextContent("@linh invited you");
    expect(
      screen.getByRole("link", { name: /Invitation to Team Sông/ }),
    ).toHaveTextContent("@someone invited you");
  });

  it("opens My organizations from a notification and closes the popover", async () => {
    vi.spyOn(organizationsService, "invitations").mockResolvedValue(
      invitations,
    );
    const onNavigate = vi.fn();

    renderNotifications({ onNavigate });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /^Notifications, 2/ }),
    );
    const link = screen.getByRole("link", { name: /Invitation to Team Gió/ });
    expect(link).toHaveAttribute("href", "/organization?tab=my-organization");
    await user.click(link);

    expect(screen.getByText(/^Location:/)).toHaveTextContent(
      "Location: /organization?tab=my-organization",
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("link", { name: /Invitation to Team Gió/ }),
    ).not.toBeInTheDocument();
  });

  it("says the user is all caught up when nobody has invited them", async () => {
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);

    renderNotifications();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Notifications" }),
    );

    expect(screen.getByText(/You're all caught up/)).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows a skeleton while the invitations load, then the list", async () => {
    let resolve!: (value: OrganizationInvitation[]) => void;
    vi.spyOn(organizationsService, "invitations").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    renderNotifications();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Notifications" }),
    );

    expect(
      within(screen.getByRole("dialog")).getByText("Notifications"),
    ).toBeVisible();
    expect(screen.queryByText(/You're all caught up/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    await act(async () => resolve(invitations));

    expect(
      await screen.findByRole("link", { name: /Invitation to Team Gió/ }),
    ).toBeVisible();
  });

  it("offers to try again when the invitations cannot be loaded", async () => {
    const load = vi
      .spyOn(organizationsService, "invitations")
      .mockRejectedValueOnce(new Error("Invitations are unavailable."))
      .mockResolvedValue(invitations);

    renderNotifications();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Notifications" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Notifications could not be loaded.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("link", { name: /Invitation to Team Gió/ }),
    ).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    { path: "/tools", refetches: true },
    { path: "/playground", refetches: false },
  ])(
    "sets refetching on focus and reconnect to $refetches at $path",
    async ({ path, refetches }) => {
      vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);

      const queryClient = renderNotifications({ initialEntry: path });
      await screen.findByRole("button", { name: "Notifications" });
      const options = invitationsObserver(queryClient)?.options;

      // Playground keeps its setup stable while a chat or call is running.
      expect(options?.refetchOnWindowFocus).toBe(refetches);
      expect(options?.refetchOnReconnect).toBe(refetches);
    },
  );
});
