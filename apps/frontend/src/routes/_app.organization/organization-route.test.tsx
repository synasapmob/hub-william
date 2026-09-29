import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import authService, { type AuthenticatedUser } from "@/services/auth";
import organizationsService, {
  type Organization,
  type OrganizationInvitation,
  type OrganizationMember,
  type OrganizationOverview,
  type OrganizationSummary,
  type OrganizationUsage,
} from "@/services/organizations";
import createQueryClient from "@/utils/utils.query-client";

import OrganizationOverviewRoute from "@/routes/_app.organization._index/route";
import OrganizationMembersRoute from "@/routes/_app.organization.members/route";
import OrganizationUsageRoute from "@/routes/_app.organization.usage/route";

import OrganizationRoute from "./route";

const first: Organization = {
  createdAt: "2026-09-20T12:00:00Z",
  description: null,
  id: "11111111-1111-4111-8111-111111111111",
  isDefault: false,
  name: "Team Mây",
  role: "owner",
};
const second: Organization = {
  createdAt: "2026-09-21T12:00:00Z",
  description: null,
  id: "22222222-2222-4222-8222-222222222222",
  isDefault: false,
  name: "Team Nắng",
  role: "member",
};

// The row My organizations shows for an organization, as the API summarizes it.
function summaryFor(organization: Organization): OrganizationSummary {
  const mine = organization.id === first.id;
  return {
    ...organization,
    agentCount: mine ? 3 : 1,
    knownCachedTokens: 0,
    knownInputTokens: 900,
    knownOutputTokens: 100,
    memberCount: mine ? 5 : 2,
    ownerUsername: organization.role === "owner" ? "ban" : "minh",
    periodDays: 30,
    requests: mine ? 12 : 2,
    tokenKnownRequests: mine ? 8 : 1,
  };
}

function asDefault(organization: Organization): Organization {
  return { ...organization, isDefault: true };
}

function overviewFor(organization: Organization): OrganizationOverview {
  return {
    agentCount: organization.id === first.id ? 3 : 1,
    agents: [],
    dailyUsage: [],
    knownCachedTokens: 0,
    knownInputTokens: 900,
    knownOutputTokens: 100,
    memberCount: organization.id === first.id ? 5 : 2,
    organization,
    periodDays: 30,
    requests: organization.id === first.id ? 12 : 2,
    tokenKnownRequests: organization.id === first.id ? 8 : 1,
  };
}

const userId = "33333333-3333-4333-8333-333333333333";

function signIn() {
  vi.spyOn(authService, "session").mockResolvedValue({
    id: userId,
    recoveryEmail: null,
    username: "ban",
  });
}

function memberOf(
  username: string,
  role: OrganizationMember["role"],
): OrganizationMember {
  return {
    id: `id-${username}`,
    invitedAt: "2026-09-20T00:00:00Z",
    invitedByUsername: null,
    joinedAt: "2026-09-20T00:00:00Z",
    role,
    status: "accepted",
    username,
  };
}

function membersFor(id: string): OrganizationMember[] {
  return id === first.id
    ? [memberOf("ban", "owner"), memberOf("minh", "member")]
    : [memberOf("minh", "owner"), memberOf("ban", "member")];
}

const invitation: OrganizationInvitation = {
  createdAt: "2026-09-25T00:00:00Z",
  id: "66666666-6666-4666-8666-666666666666",
  invitedByUsername: "linh",
  organizationId: "77777777-7777-4777-8777-777777777777",
  organizationName: "Team Gió",
};

function RouteLocation() {
  const location = useLocation();
  return (
    <>
      <output>Current route: {location.pathname}</output>
      <output>Query: {location.search}</output>
    </>
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: Error) => void;
  resolve: (value: T) => void;
}

// A promise a test settles by hand, to hold a request in flight.
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

const signedInUser: AuthenticatedUser = {
  id: userId,
  recoveryEmail: null,
  username: "ban",
};

function renderRoute(initialEntry = "/organization") {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceShellSession>
        <MemoryRouter initialEntries={[initialEntry]}>
          <RouteLocation />
          <Routes>
            <Route path="/organization" element={<OrganizationRoute />}>
              <Route index element={<OrganizationOverviewRoute />} />
              <Route path="members" element={<OrganizationMembersRoute />} />
              <Route path="usage" element={<OrganizationUsageRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </WorkspaceShellSession>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage?.clear();
});

describe("Organization overview", () => {
  it("returns direct subpage visits to Overview when no organization exists", async () => {
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list").mockResolvedValue([]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);

    renderRoute("/organization/usage");

    expect(
      await screen.findByRole("heading", { name: "Create an organization" }),
    ).toBeVisible();
    expect(screen.getByText("Current route: /organization")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Organization name" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Description (optional)" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Usage" })).toBeNull();
  });

  it("makes the organization picked in My organizations the default and shows only its real aggregate", async () => {
    signIn();
    vi.spyOn(organizationsService, "list").mockResolvedValue([first, second]);
    vi.spyOn(organizationsService, "summaries").mockResolvedValue([
      summaryFor(first),
      summaryFor(second),
    ]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    const setDefault = vi
      .spyOn(organizationsService, "setDefault")
      .mockResolvedValue();
    const overview = vi
      .spyOn(organizationsService, "overview")
      .mockImplementation(async (id) =>
        overviewFor(id === first.id ? first : second),
      );

    renderRoute();

    expect(await screen.findByText("Team Mây")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Selected organization" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText("Reported by 8 of 12 requests"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "My organizations" }));
    const dialog = screen.getByRole("dialog", { name: "My organizations" });
    await user.click(
      await within(dialog).findByRole("button", { name: "Team Nắng" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText("Reported by 1 of 2 requests"),
    ).toBeVisible();
    expect(screen.getByText("Team Nắng")).toBeVisible();
    expect(overview).toHaveBeenCalledWith(second.id, 30);
    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(setDefault).toHaveBeenCalledWith(second.id);
  });

  it("opens with the organization the server marks as the default, whatever the browser remembers", async () => {
    signIn();
    window.localStorage.setItem(`hub-william:organization:${userId}`, first.id);
    const list = vi
      .spyOn(organizationsService, "list")
      .mockResolvedValue([first, asDefault(second)]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    const overview = vi
      .spyOn(organizationsService, "overview")
      .mockImplementation(async (id) =>
        overviewFor(id === first.id ? first : second),
      );

    renderRoute();

    expect(await screen.findByText("Team Nắng")).toBeVisible();
    expect(
      await screen.findByText("Reported by 1 of 2 requests"),
    ).toBeVisible();
    expect(screen.queryByText("Team Mây")).not.toBeInTheDocument();
    expect(overview).not.toHaveBeenCalledWith(first.id, expect.anything());
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("stands in the oldest organization until a default exists, and choosing it makes it one", async () => {
    const { setDefault, summaries } = arrange();

    renderRoute();
    const user = userEvent.setup();
    expect(await screen.findByText("Team Mây")).toBeVisible();
    expect(summaries).not.toHaveBeenCalled();
    const dialog = await openManageDialog(user);
    const mine = await within(dialog).findByRole("row", { name: /Team Mây/ });
    expect(within(mine).getByText("Default")).toBeVisible();

    await user.click(within(mine).getByRole("button", { name: "Team Mây" }));

    await waitFor(() => expect(setDefault).toHaveBeenCalledWith(first.id));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Team Mây")).toBeVisible();
  });

  it("does not ask the server again to make the current default the default", async () => {
    const { setDefault } = arrange({
      organizations: [asDefault(first), second],
    });

    renderRoute();
    const user = userEvent.setup();
    const dialog = await openManageDialog(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Team Mây" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(setDefault).not.toHaveBeenCalled();
    expect(screen.getByText("Team Mây")).toBeVisible();
  });

  it("keeps the dialog open and the page unchanged when the choice cannot be saved", async () => {
    const { setDefault } = arrange();
    setDefault.mockRejectedValueOnce(
      new Error("You do not have permission to perform this action."),
    );

    renderRoute();
    const user = userEvent.setup();
    expect(await screen.findByText("Team Mây")).toBeVisible();
    const dialog = await openManageDialog(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Team Nắng" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "You do not have permission to perform this action.",
    );
    expect(dialog).toBeVisible();
    expect(
      within(within(dialog).getByRole("row", { name: /Team Mây/ })).getByText(
        "Default",
      ),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("row", { name: /Team Nắng.*Default/ }),
    ).not.toBeInTheDocument();
    // The next attempt goes through and clears the message.
    await user.click(within(dialog).getByRole("button", { name: "Team Nắng" }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Team Nắng")).toBeVisible();
  });

  it("opens New organization in a dialog and selects the created team", async () => {
    const created: Organization = {
      createdAt: "2026-09-24T00:00:00Z",
      description: null,
      id: "55555555-5555-4555-8555-555555555555",
      isDefault: true,
      name: "Team Sông",
      role: "owner",
    };
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list")
      .mockResolvedValueOnce([first])
      .mockResolvedValue([first, created]);
    // (The server made the new organization the default, so `created` says so.)
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    vi.spyOn(organizationsService, "overview").mockImplementation(async (id) =>
      overviewFor(id === created.id ? created : first),
    );
    const create = vi
      .spyOn(organizationsService, "create")
      .mockResolvedValue(created);

    renderRoute();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "New organization" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Create an organization",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Organization name" }),
      "Team Sông",
    );
    const description = within(dialog).getByRole("textbox", {
      name: "Description (optional)",
    });
    fireEvent.change(description, { target: { value: "x".repeat(351) } });
    await user.click(
      within(dialog).getByRole("button", { name: "Create organization" }),
    );
    expect(
      within(dialog).getByText("Use 350 characters or fewer."),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();

    const emojiDescription = "😀".repeat(200);
    fireEvent.change(description, { target: { value: emojiDescription } });
    expect(within(dialog).getByText("200/350")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Create organization" }),
    );

    await waitFor(() =>
      expect(create.mock.calls[0]?.[0]).toEqual({
        description: emojiDescription,
        name: "Team Sông",
      }),
    );
    await waitFor(() => expect(screen.getByText("Team Sông")).toBeVisible());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// Accepting an invitation makes the joined organization the default.
const joined: Organization = {
  createdAt: "2026-09-26T12:00:00Z",
  description: null,
  id: invitation.organizationId,
  isDefault: true,
  name: "Team Gió",
  role: "member",
};

interface ArrangeOptions {
  invitations?: OrganizationInvitation[];
  organizations?: Organization[];
}

function arrange({
  invitations = [],
  organizations = [first, second],
}: ArrangeOptions = {}) {
  signIn();
  return {
    invitations: vi
      .spyOn(organizationsService, "invitations")
      .mockResolvedValue(invitations),
    list: vi
      .spyOn(organizationsService, "list")
      .mockResolvedValue(organizations),
    members: vi
      .spyOn(organizationsService, "members")
      .mockImplementation(async (id) => membersFor(id)),
    overview: vi
      .spyOn(organizationsService, "overview")
      .mockImplementation(async (id) =>
        overviewFor(id === first.id ? first : second),
      ),
    setDefault: vi
      .spyOn(organizationsService, "setDefault")
      .mockResolvedValue(),
    summaries: vi
      .spyOn(organizationsService, "summaries")
      .mockResolvedValue(organizations.map(summaryFor)),
  };
}

// What the server reports: `before` the first time it is asked, `after` every
// time since, once something has changed.
function serverReports(
  spies: Pick<ReturnType<typeof arrange>, "list" | "summaries">,
  before: Organization[],
  after: Organization[],
) {
  spies.list.mockResolvedValueOnce(before).mockResolvedValue(after);
  spies.summaries
    .mockResolvedValueOnce(before.map(summaryFor))
    .mockResolvedValue(after.map(summaryFor));
}

async function openManageDialog(user: UserEvent) {
  await user.click(
    await screen.findByRole("button", { name: /My organizations/ }),
  );
  return screen.getByRole("dialog", { name: "My organizations" });
}

async function removeFrom(user: UserEvent, dialog: HTMLElement, name: RegExp) {
  await user.click(
    within(within(dialog).getByRole("row", { name })).getByRole("button", {
      name: "Remove",
    }),
  );
}

describe("My organizations", () => {
  it("lists each organization with its owner, agents, members, tokens and created date from one summary request", async () => {
    const { members, overview, summaries } = arrange();

    renderRoute();
    const user = userEvent.setup();
    const dialog = await openManageDialog(user);

    expect(
      within(dialog).getByRole("columnheader", { name: /Tokens/ }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("columnheader", { name: /Tokens.*30d/ }),
    ).toBeVisible();
    const mine = await within(dialog).findByRole("row", { name: /Team Mây/ });
    expect(within(mine).getByText("@ban")).toBeVisible();
    expect(within(mine).getByText("(you)")).toBeVisible();
    expect(within(mine).getByText("3")).toBeVisible();
    expect(within(mine).getByText("5")).toBeVisible();
    expect(within(mine).getByText("1K")).toBeVisible();
    expect(within(mine).getByText("Sep 20, 2026")).toBeVisible();
    expect(within(mine).getByText("Default")).toBeVisible();

    const other = within(dialog).getByRole("row", { name: /Team Nắng/ });
    expect(within(other).getByText("@minh")).toBeVisible();
    expect(within(other).queryByText("(you)")).not.toBeInTheDocument();
    expect(within(other).getByText("1")).toBeVisible();
    expect(within(other).getByText("2")).toBeVisible();
    expect(within(other).getByText("Sep 21, 2026")).toBeVisible();
    expect(within(other).queryByText("Default")).not.toBeInTheDocument();

    // One request feeds every row. Nothing is asked per organization.
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(members).not.toHaveBeenCalled();
    expect(overview.mock.calls.every(([id]) => id === first.id)).toBe(true);
  });

  it("shows why the organizations could not be loaded and loads them on retry", async () => {
    const { summaries } = arrange();
    summaries
      .mockRejectedValueOnce(new Error("Organizations are unavailable."))
      .mockResolvedValue([summaryFor(first), summaryFor(second)]);

    renderRoute();
    const user = userEvent.setup();
    expect(await screen.findByText("Team Mây")).toBeVisible();
    const dialog = await openManageDialog(user);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Organizations are unavailable.",
    );
    expect(
      within(dialog).queryByText(/You have not joined an organization yet/),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("row", { name: /Team/ })).toBeNull();
    await user.click(
      within(dialog).getByRole("button", { name: "Retry organizations" }),
    );

    expect(
      await within(dialog).findByRole("row", { name: /Team Nắng/ }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "Retry organizations" }),
    ).not.toBeInTheDocument();
  });

  it("asks an owner to confirm, then deletes the organization for everyone", async () => {
    const { list, members, overview, summaries } = arrange();
    serverReports({ list, summaries }, [first, second], [second]);
    const deleteOrganization = vi
      .spyOn(organizationsService, "deleteOrganization")
      .mockResolvedValue();
    const leave = vi.spyOn(organizationsService, "leave").mockResolvedValue();

    renderRoute();
    const user = userEvent.setup();
    let dialog = await openManageDialog(user);
    await removeFrom(user, dialog, /Team Mây/);

    let confirm = screen.getByRole("dialog", { name: "Delete Team Mây?" });
    expect(
      within(confirm).getByText(/Everyone in it will leave/),
    ).toBeVisible();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete Team Mây?" }),
      ).not.toBeInTheDocument(),
    );
    expect(deleteOrganization).not.toHaveBeenCalled();

    dialog = screen.getByRole("dialog", { name: "My organizations" });
    await removeFrom(user, dialog, /Team Mây/);
    const callsFor = (spy: typeof overview | typeof members) =>
      spy.mock.calls.filter(([id]) => id === first.id).length;
    const before = [callsFor(overview), callsFor(members)];
    confirm = screen.getByRole("dialog", { name: "Delete Team Mây?" });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete organization" }),
    );

    await waitFor(() =>
      expect(deleteOrganization).toHaveBeenCalledWith(first.id),
    );
    expect(leave).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete Team Mây?" }),
      ).not.toBeInTheDocument(),
    );
    dialog = screen.getByRole("dialog", { name: "My organizations" });
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("row", { name: /Team Mây/ }),
      ).not.toBeInTheDocument(),
    );
    const remaining = within(dialog).getByRole("row", { name: /Team Nắng/ });
    expect(within(remaining).getByText("Default")).toBeVisible();
    expect(
      [callsFor(overview), callsFor(members)],
      "nothing is refetched for an organization that no longer exists",
    ).toEqual(before);
  });

  it("asks a member to confirm, then only leaves that organization", async () => {
    const { list, summaries } = arrange();
    serverReports({ list, summaries }, [first, second], [first]);
    const deleteOrganization = vi
      .spyOn(organizationsService, "deleteOrganization")
      .mockResolvedValue();
    const leave = vi.spyOn(organizationsService, "leave").mockResolvedValue();

    renderRoute();
    const user = userEvent.setup();
    let dialog = await openManageDialog(user);
    await removeFrom(user, dialog, /Team Nắng/);

    const confirm = screen.getByRole("dialog", { name: "Leave Team Nắng?" });
    expect(
      within(confirm).getByText(
        /won't be able to use anything related to it anymore/,
      ),
    ).toBeVisible();
    expect(
      within(confirm).queryByText(/Everyone in it/),
    ).not.toBeInTheDocument();
    await user.click(
      within(confirm).getByRole("button", { name: "Leave organization" }),
    );

    await waitFor(() => expect(leave).toHaveBeenCalledWith(second.id));
    expect(deleteOrganization).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Leave Team Nắng?" }),
      ).not.toBeInTheDocument(),
    );
    dialog = screen.getByRole("dialog", { name: "My organizations" });
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("row", { name: /Team Nắng/ }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(within(dialog).getByRole("row", { name: /Team Mây/ })).getByText(
        "Default",
      ),
    ).toBeVisible();
  });

  it("falls back to the create form when the last organization is removed", async () => {
    const { list, summaries } = arrange({ organizations: [first] });
    serverReports({ list, summaries }, [first], []);
    const deleteOrganization = vi
      .spyOn(organizationsService, "deleteOrganization")
      .mockResolvedValue();

    renderRoute();
    const user = userEvent.setup();
    let dialog = await openManageDialog(user);
    await removeFrom(user, dialog, /Team Mây/);
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Delete Team Mây?" }),
      ).getByRole("button", { name: "Delete organization" }),
    );

    await waitFor(() =>
      expect(deleteOrganization).toHaveBeenCalledWith(first.id),
    );
    dialog = await screen.findByRole("dialog", { name: "My organizations" });
    expect(
      await within(dialog).findByText(
        /You have not joined an organization yet/,
      ),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("heading", { name: "Create an organization" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "New organization" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "My organizations" }),
    ).toBeVisible();
  });

  it("keeps the organization and explains why when it cannot be removed", async () => {
    arrange();
    vi.spyOn(organizationsService, "deleteOrganization").mockRejectedValue(
      new Error("You do not have permission to perform this action."),
    );

    renderRoute();
    const user = userEvent.setup();
    const dialog = await openManageDialog(user);
    await removeFrom(user, dialog, /Team Mây/);
    const confirm = screen.getByRole("dialog", { name: "Delete Team Mây?" });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete organization" }),
    );

    expect(await within(confirm).findByRole("alert")).toHaveTextContent(
      "You do not have permission to perform this action.",
    );
    expect(
      within(confirm).getByRole("button", { name: "Delete organization" }),
    ).toBeEnabled();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "My organizations" }),
      ).toBeVisible(),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("row", { name: /Team Mây/ }),
    ).toBeVisible();
  });

  it("keeps invitations inside the dialog and accepting one makes it the default", async () => {
    const { invitations, list, summaries } = arrange({
      invitations: [invitation],
    });
    invitations.mockResolvedValueOnce([invitation]).mockResolvedValue([]);
    serverReports(
      { list, summaries },
      [first, second],
      [first, second, joined],
    );
    const acceptInvitation = vi
      .spyOn(organizationsService, "acceptInvitation")
      .mockResolvedValue(joined);

    renderRoute();
    const user = userEvent.setup();
    expect(
      await screen.findByRole("button", {
        name: /My organizations.*1.*pending invitations/,
      }),
    ).toBeVisible();
    expect(screen.queryByText("Invitations for you")).not.toBeInTheDocument();
    expect(screen.queryByText(/invited by @linh/)).not.toBeInTheDocument();

    const dialog = await openManageDialog(user);
    expect(
      within(dialog).getByRole("heading", { name: "Invitations" }),
    ).toBeVisible();
    expect(within(dialog).getByText("Team Gió")).toBeVisible();
    expect(within(dialog).getByText(/invited by @linh/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(acceptInvitation).toHaveBeenCalledWith(invitation.id),
    );
    const row = await within(dialog).findByRole("row", { name: /Team Gió/ });
    expect(within(row).getByText("Default")).toBeVisible();
    await waitFor(() =>
      expect(within(dialog).getByText("No pending invitations.")).toBeVisible(),
    );
    // The server made it the default, so the pages behind the dialog show it.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Team Gió")).toBeVisible();
    expect(screen.queryByText("Team Mây")).not.toBeInTheDocument();
  });

  it("declines an invitation from the dialog", async () => {
    const { invitations } = arrange({ invitations: [invitation] });
    invitations.mockResolvedValueOnce([invitation]).mockResolvedValue([]);
    const declineInvitation = vi
      .spyOn(organizationsService, "declineInvitation")
      .mockResolvedValue();
    const acceptInvitation = vi.spyOn(organizationsService, "acceptInvitation");

    renderRoute();
    const user = userEvent.setup();
    const dialog = await openManageDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(declineInvitation).toHaveBeenCalledWith(invitation.id),
    );
    expect(acceptInvitation).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(within(dialog).getByText("No pending invitations.")).toBeVisible(),
    );
    expect(
      within(within(dialog).getByRole("row", { name: /Team Mây/ })).getByText(
        "Default",
      ),
    ).toBeVisible();
  });

  it("offers a retry when invitations cannot be loaded", async () => {
    const { invitations } = arrange();
    invitations
      .mockRejectedValueOnce(new Error("Invitations are unavailable."))
      .mockResolvedValue([invitation]);

    renderRoute();
    const user = userEvent.setup();
    const dialog = await openManageDialog(user);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Invitations are unavailable.",
    );
    expect(
      within(dialog).queryByText("No pending invitations."),
    ).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Retry invitations" }),
    );

    expect(await within(dialog).findByText(/invited by @linh/)).toBeVisible();
  });

  it("lets someone without an organization open their invitations", async () => {
    const { invitations, list, summaries } = arrange({
      invitations: [invitation],
      organizations: [],
    });
    invitations.mockResolvedValueOnce([invitation]).mockResolvedValue([]);
    serverReports({ list, summaries }, [], [joined]);
    vi.spyOn(organizationsService, "acceptInvitation").mockResolvedValue(
      joined,
    );

    renderRoute();
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "Create an organization" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "New organization" }),
    ).not.toBeInTheDocument();
    const dialog = await openManageDialog(user);
    expect(
      within(dialog).getByText(/You have not joined an organization yet/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(
        within(dialog).getByRole("row", { name: /Team Gió/ }),
      ).toBeVisible(),
    );
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("heading", { name: "Overview" }),
    ).toBeVisible();
    expect(screen.getByText("Team Gió")).toBeVisible();
  });
});

const emptyUsage: OrganizationUsage = {
  breakdown: [],
  dailyUsage: [],
  knownCachedTokens: 0,
  knownInputTokens: 0,
  knownOutputTokens: 0,
  periodDays: 30,
  requests: 0,
  tokenKnownRequests: 0,
};

describe("Organization loading", () => {
  it("renders the page skeleton from the first paint instead of loading text", async () => {
    const session = deferred<AuthenticatedUser | null>();
    vi.spyOn(authService, "session").mockReturnValue(session.promise);
    const list = deferred<Organization[]>();
    vi.spyOn(organizationsService, "list").mockReturnValue(list.promise);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    vi.spyOn(organizationsService, "overview").mockResolvedValue(
      overviewFor(first),
    );

    renderRoute();

    // While the session is checked, the page already has its shape.
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByText("Loading overview")).toBeInTheDocument();
    for (const text of ["Loading…", "Loading organizations…", "—"])
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /My organizations|New organization/,
      }),
    ).not.toBeInTheDocument();

    await act(async () => session.resolve(signedInUser));

    // Then the organization list: the same skeleton, and no create form yet.
    expect(screen.getByText("Loading overview")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Create an organization" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /My organizations/ }),
    ).not.toBeInTheDocument();

    await act(async () => list.resolve([first]));

    expect(
      await screen.findByRole("button", { name: /My organizations/ }),
    ).toBeVisible();
    expect(screen.getByText("Team Mây")).toBeVisible();
    expect(
      await screen.findByText("Reported by 8 of 12 requests"),
    ).toBeVisible();
    expect(screen.queryByText("Loading overview")).not.toBeInTheDocument();
  });

  it("shows the create form only once the list says there is no organization", async () => {
    signIn();
    const list = deferred<Organization[]>();
    const listSpy = vi
      .spyOn(organizationsService, "list")
      .mockReturnValue(list.promise);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);

    renderRoute();

    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(screen.getByText("Loading overview")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Create an organization" }),
    ).not.toBeInTheDocument();

    await act(async () => list.resolve([]));

    expect(
      await screen.findByRole("heading", { name: "Create an organization" }),
    ).toBeVisible();
    expect(screen.queryByText("Loading overview")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Overview" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Overview's values, chart and agents as placeholders until its data arrives", async () => {
    signIn();
    vi.spyOn(organizationsService, "list").mockResolvedValue([first]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    const overview = deferred<OrganizationOverview>();
    vi.spyOn(organizationsService, "overview").mockReturnValue(
      overview.promise,
    );

    renderRoute();

    expect(await screen.findByText("Team Mây")).toBeVisible();
    expect(screen.getByText("Loading overview")).toBeInTheDocument();
    // Titles and labels are real; nothing claims an empty or zero state yet.
    expect(screen.getByText("Daily usage")).toBeVisible();
    expect(screen.getByText("Team agents")).toBeVisible();
    for (const text of [
      "—",
      "Loading usage…",
      "No agents shared with this organization yet.",
      "No requests recorded in this period.",
    ])
      expect(screen.queryByText(text)).not.toBeInTheDocument();

    await act(async () => overview.resolve(overviewFor(first)));

    expect(
      await screen.findByText("Reported by 8 of 12 requests"),
    ).toBeVisible();
    expect(
      screen.getByText("No agents shared with this organization yet."),
    ).toBeVisible();
    expect(
      screen.getByText("No requests recorded in this period."),
    ).toBeVisible();
    expect(screen.queryByText("Loading overview")).not.toBeInTheDocument();
  });

  it("keeps the members list and their request counts as placeholders until they load", async () => {
    signIn();
    vi.spyOn(organizationsService, "list").mockResolvedValue([first]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    const members = deferred<OrganizationMember[]>();
    vi.spyOn(organizationsService, "members").mockReturnValue(members.promise);
    const usage = deferred<OrganizationUsage>();
    vi.spyOn(organizationsService, "usage").mockReturnValue(usage.promise);

    renderRoute("/organization/members");

    expect(await screen.findByText("Team Mây")).toBeVisible();
    expect(screen.getByText("Loading members")).toBeInTheDocument();
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No active members are available yet."),
    ).not.toBeInTheDocument();
    // An owner's invite form does not depend on the list, so it is real already.
    expect(
      screen.getByRole("heading", { name: "Invite a member" }),
    ).toBeVisible();

    await act(async () => members.resolve(membersFor(first.id)));

    expect(await screen.findAllByText(/requests in 30 days/)).toHaveLength(2);
    expect(screen.queryByText("0")).not.toBeInTheDocument();

    await act(async () =>
      usage.resolve({
        ...emptyUsage,
        breakdown: [
          {
            connectionId: null,
            knownCachedTokens: 0,
            knownInputTokens: 0,
            knownOutputTokens: 0,
            memberId: "id-ban",
            model: null,
            provider: "deepseek",
            requests: 7,
            tokenKnownRequests: 0,
            username: "ban",
          },
        ],
        requests: 7,
      }),
    );

    expect(await screen.findByText("7")).toBeVisible();
    expect(screen.getByText("0")).toBeVisible();
    expect(screen.queryByText("Loading members")).not.toBeInTheDocument();
  });

  it("does not claim there are no requests while usage is loading", async () => {
    signIn();
    vi.spyOn(organizationsService, "list").mockResolvedValue([first]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    vi.spyOn(organizationsService, "members").mockResolvedValue([]);
    vi.spyOn(organizationsService, "agents").mockResolvedValue([]);
    const usage = deferred<OrganizationUsage>();
    vi.spyOn(organizationsService, "usage").mockReturnValue(usage.promise);

    renderRoute("/organization/usage");

    expect(await screen.findByText("Team Mây")).toBeVisible();
    expect(screen.getByText("Loading usage")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "By member and model" }),
    ).toBeVisible();
    for (const text of [
      "—",
      "Loading usage…",
      "No requests match this period and these filters.",
      "No requests recorded in this period.",
    ])
      expect(screen.queryByText(text)).not.toBeInTheDocument();

    await act(async () => usage.resolve(emptyUsage));

    expect(
      await screen.findByText(
        "No requests match this period and these filters.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("No requests recorded in this period."),
    ).toBeVisible();
    expect(screen.queryByText("Loading usage")).not.toBeInTheDocument();
  });
});

describe("Organization header", () => {
  it("shows the organization as a badge beside the label, with 36px buttons", async () => {
    arrange();

    renderRoute();

    const name = await screen.findByText("Team Mây");
    expect(name.closest('[data-slot="badge"]')).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /My organizations/ }),
    ).toHaveAttribute("data-size", "lg");
    expect(
      screen.getByRole("button", { name: "New organization" }),
    ).toHaveAttribute("data-size", "lg");
  });
});

describe("My organizations in the URL", () => {
  it("opens from ?tab=my-organization, with skeleton rows until the summaries load", async () => {
    signIn();
    vi.spyOn(organizationsService, "list").mockResolvedValue([first, second]);
    const summaries = deferred<OrganizationSummary[]>();
    vi.spyOn(organizationsService, "summaries").mockReturnValue(
      summaries.promise,
    );
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([
      invitation,
    ]);
    vi.spyOn(organizationsService, "overview").mockImplementation(async (id) =>
      overviewFor(id === first.id ? first : second),
    );

    renderRoute("/organization?tab=my-organization");

    const dialog = await screen.findByRole("dialog", {
      name: "My organizations",
    });
    expect(within(dialog).getByText("Loading organizations")).toBeVisible();
    expect(
      within(dialog).queryByText(/You have not joined an organization yet/),
    ).not.toBeInTheDocument();

    await act(async () =>
      summaries.resolve([summaryFor(first), summaryFor(second)]),
    );

    expect(
      await within(dialog).findByRole("row", { name: /Team Mây/ }),
    ).toBeVisible();
    expect(await within(dialog).findByText(/invited by @linh/)).toBeVisible();

    await userEvent.setup().keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/^Query:/)).toHaveTextContent(/^Query:\s*$/);
  });

  it("puts the dialog in the URL when it opens and takes it out when an organization is chosen", async () => {
    arrange();
    vi.spyOn(organizationsService, "agents").mockResolvedValue([]);
    vi.spyOn(organizationsService, "usage").mockResolvedValue(emptyUsage);

    renderRoute("/organization/usage?member=id-minh");

    const user = userEvent.setup();
    const dialog = await openManageDialog(user);
    expect(screen.getByText(/^Query:/)).toHaveTextContent(
      "Query: ?member=id-minh&tab=my-organization",
    );

    await user.click(
      await within(dialog).findByRole("button", { name: "Team Nắng" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/^Query:/)).toHaveTextContent(/^Query:\s*$/);
    expect(
      screen.getByText("Current route: /organization/usage"),
    ).toBeVisible();
  });

  it("does not open for someone who is signed out", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);

    renderRoute("/organization?tab=my-organization");

    expect(await screen.findByText("Your teams, in one place")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Organization usage", () => {
  it("keeps a member link filtered while the member list is loading", async () => {
    const memberId = "44444444-4444-4444-8444-444444444444";
    let resolveMembers!: (members: OrganizationMember[]) => void;
    const membersPending = new Promise<OrganizationMember[]>((resolve) => {
      resolveMembers = resolve;
    });
    vi.spyOn(authService, "session").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      recoveryEmail: null,
      username: "ban",
    });
    vi.spyOn(organizationsService, "list").mockResolvedValue([first]);
    vi.spyOn(organizationsService, "invitations").mockResolvedValue([]);
    vi.spyOn(organizationsService, "members").mockReturnValue(membersPending);
    vi.spyOn(organizationsService, "agents").mockResolvedValue([]);
    const usage = vi
      .spyOn(organizationsService, "usage")
      .mockImplementation(async (_id, filters) => ({
        breakdown: [],
        dailyUsage: [],
        knownCachedTokens: 0,
        knownInputTokens: 0,
        knownOutputTokens: 0,
        periodDays: filters.days,
        requests: filters.memberId ? 1 : 9,
        tokenKnownRequests: 0,
      }));

    renderRoute(`/organization/usage?member=${memberId}`);

    await waitFor(() =>
      expect(usage).toHaveBeenCalledWith(first.id, {
        days: 30,
        memberId,
        connectionId: undefined,
        model: undefined,
      }),
    );
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("heading", { name: "Requests" }).parentElement!,
        ).getByText("1"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("combobox", { name: "Member" })).toHaveTextContent(
      "Loading member…",
    );

    resolveMembers([
      {
        id: memberId,
        invitedAt: "2026-09-20T00:00:00Z",
        invitedByUsername: "ban",
        joinedAt: "2026-09-21T00:00:00Z",
        role: "member",
        status: "accepted",
        username: "minh",
      },
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Member" }),
      ).toHaveTextContent("@minh"),
    );
  });
});
