import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import {
  sessionService,
  type SessionState,
} from "@/services/session/session-service";
import createQueryClient from "@/utils/utils.query-client";

import DashboardSessionGate from "./dashboard-session-gate";
import { useDashboardSession } from "./dashboard-session-context";

// The toaster is not rendered here, so a toast is read from the calls made to it.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

// What the server would answer is decided by each test.
vi.mock("@/services/session/session-service", () => ({
  sessionService: {
    login: vi.fn(),
    load: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
    queryKey: ["dashboard", "session"],
  },
}));

const load = vi.mocked(sessionService.load);
const login = vi.mocked(sessionService.login);
const logout = vi.mocked(sessionService.logout);
const register = vi.mocked(sessionService.register);

const READY: SessionState = {
  identity: {
    id: "account-1",
    permissions: ["orders", "history"],
    role: "cashier",
    username: "thuha",
  },
  status: "ready",
};

/** What the gate lets through: who is signed in, and a way out. */
function Inside() {
  const session = useDashboardSession();

  return (
    <div>
      <p>
        Inside as {session.staff.name} ({session.staff.role})
      </p>

      <p>{session.can("orders") ? "may open orders" : "may not open orders"}</p>

      <p>{session.can("stock") ? "may open stock" : "may not open stock"}</p>

      <button onClick={session.signOut}>Leave</button>
    </div>
  );
}

/** A page whose request is refused because the session is gone. */
function Failing({ ask }: { ask: () => Promise<never> }) {
  useQuery({ queryFn: ask, queryKey: ["dashboard", "orders"] });

  return <p>Orders page</p>;
}

function renderGate(page: ReactNode = <Inside />) {
  const queryClient = createQueryClient();

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardSessionGate>{page}</DashboardSessionGate>
    </QueryClientProvider>,
  );

  return queryClient;
}

beforeEach(() => {
  vi.resetAllMocks();
  logout.mockResolvedValue(undefined);
});

describe("DashboardSessionGate", () => {
  it("says it is checking until the server has answered", () => {
    load.mockReturnValue(new Promise(() => {}));

    renderGate();

    expect(screen.getByText("Checking your session…")).toBeInTheDocument();
    expect(screen.queryByText(/Inside as/)).not.toBeInTheDocument();
  });

  it("lets a member of staff in, with the role and permissions the server gave", async () => {
    load.mockResolvedValue(READY);

    renderGate();

    expect(
      await screen.findByText("Inside as thuha (cashier)"),
    ).toBeInTheDocument();
    expect(screen.getByText("may open orders")).toBeInTheDocument();
    expect(screen.getByText("may not open stock")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  describe("signed out", () => {
    it("asks for the account's username and password, and shows nothing of the dashboard", async () => {
      load.mockResolvedValue({ status: "signed-out" });

      renderGate();

      expect(await screen.findByText("Dashboard login")).toBeInTheDocument();
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
      expect(screen.getByLabelText("Password")).toHaveAttribute(
        "type",
        "password",
      );
      expect(screen.queryByText(/Inside as/)).not.toBeInTheDocument();
    });

    it("will not send an empty form", async () => {
      load.mockResolvedValue({ status: "signed-out" });
      const user = userEvent.setup();

      renderGate();
      await screen.findByText("Dashboard login");

      expect(screen.getByRole("button", { name: "Login" })).toBeDisabled();

      await user.type(screen.getByLabelText("Username"), "thuha");

      expect(screen.getByRole("button", { name: "Login" })).toBeDisabled();

      await user.type(screen.getByLabelText("Password"), "s3cret-pass");

      expect(screen.getByRole("button", { name: "Login" })).toBeEnabled();
    });

    it("signs in, then asks the server who that is, and lets them in", async () => {
      load
        .mockResolvedValueOnce({ status: "signed-out" })
        .mockResolvedValueOnce(READY);
      login.mockResolvedValue("thuha");
      const user = userEvent.setup();

      renderGate();
      await screen.findByText("Dashboard login");
      await user.type(screen.getByLabelText("Username"), "  thuha ");
      await user.type(screen.getByLabelText("Password"), "s3cret-pass");
      await user.click(screen.getByRole("button", { name: "Login" }));

      expect(
        await screen.findByText("Inside as thuha (cashier)"),
      ).toBeInTheDocument();
      // The name is trimmed; the password is sent exactly as typed.
      expect(login).toHaveBeenCalledWith({
        password: "s3cret-pass",
        username: "thuha",
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(toast.success).toHaveBeenCalledWith("Logged in", {
        description: "You are signed in as thuha.",
      });
    });

    it("says in a toast why the sign-in failed, and stays on the form", async () => {
      load.mockResolvedValue({ status: "signed-out" });
      login.mockRejectedValue(
        new ServiceError(
          "The username or password is incorrect.",
          401,
          "invalid_credentials",
        ),
      );
      const user = userEvent.setup();

      renderGate();
      await screen.findByText("Dashboard login");
      await user.type(screen.getByLabelText("Username"), "thuha");
      await user.type(screen.getByLabelText("Password"), "wrong");
      await user.click(screen.getByRole("button", { name: "Login" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Could not log in", {
          description: "The username or password is incorrect.",
        }),
      );
      // Wrong credentials are not an expired session.
      expect(toast.error).not.toHaveBeenCalledWith(
        "Your session has expired",
        expect.anything(),
      );
      expect(screen.queryByText(/Inside as/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Username")).toHaveValue("thuha");
      // Nothing is asked again, since nothing changed.
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("making an account", () => {
    // The toggle and the submit button share a name, so the submit is told by its type.
    const toggle = (name: string) =>
      screen
        .getAllByRole("button", { name })
        .find(
          (button) => button.getAttribute("type") !== "submit",
        ) as HTMLElement;
    const create = () =>
      screen
        .getAllByRole("button", { name: "Register" })
        .find(
          (button) => button.getAttribute("type") === "submit",
        ) as HTMLElement;

    async function openRegister() {
      load.mockResolvedValue({ status: "signed-out" });

      const user = userEvent.setup();

      renderGate();
      await screen.findByText("Dashboard login");
      await user.click(toggle("Register"));

      return user;
    }

    it("is offered on the sign-in form, and the way back is offered on its own", async () => {
      const user = await openRegister();

      expect(
        screen.getByRole("heading", { name: "Register" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
      expect(screen.getByLabelText("Recovery email")).toHaveAttribute(
        "type",
        "email",
      );
      expect(screen.getByLabelText("Password")).toHaveAttribute(
        "type",
        "password",
      );
      // It says the account is the storefront's, and what to do once it is made.
      expect(
        screen.getByText(/shared with the storefront/),
      ).toBeInTheDocument();

      await user.click(toggle("Login"));

      expect(screen.getByText("Dashboard login")).toBeInTheDocument();
      expect(screen.queryByLabelText("Recovery email")).not.toBeInTheDocument();
    });

    it("will not send a form that the API would refuse", async () => {
      const user = await openRegister();
      expect(create()).toBeDisabled();

      await user.type(screen.getByLabelText("Username"), "an");
      await user.type(
        screen.getByLabelText("Recovery email"),
        "an@example.com",
      );
      await user.type(screen.getByLabelText("Password"), "s3cret-pass");

      // Two letters are not a username.
      expect(create()).toBeDisabled();
      expect(screen.getByText(/3 to 32 letters/)).toBeInTheDocument();

      await user.type(screen.getByLabelText("Username"), "b");

      expect(create()).toBeEnabled();

      await user.clear(screen.getByLabelText("Recovery email"));
      await user.type(screen.getByLabelText("Recovery email"), "not-an-email");

      expect(create()).toBeDisabled();

      await user.clear(screen.getByLabelText("Recovery email"));
      await user.type(
        screen.getByLabelText("Recovery email"),
        "an@example.com",
      );
      await user.clear(screen.getByLabelText("Password"));
      await user.type(screen.getByLabelText("Password"), "1234567");

      expect(create()).toBeDisabled();
      expect(
        screen.getByText("A password is 8 to 128 characters."),
      ).toBeInTheDocument();

      await user.type(screen.getByLabelText("Password"), "8");

      expect(create()).toBeEnabled();

      // 128 characters are the most the API takes.
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "a".repeat(129) },
      });

      expect(create()).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "a".repeat(128) },
      });

      expect(create()).toBeEnabled();
      expect(register).not.toHaveBeenCalled();
    });

    it("makes the account, asks the server who that is, and says whose it is when they are not staff yet", async () => {
      load
        .mockResolvedValueOnce({ status: "signed-out" })
        .mockResolvedValueOnce({ status: "forbidden", username: "an_binh" });
      register.mockResolvedValue("an_binh");
      const user = userEvent.setup();

      renderGate();
      await user.click(await screen.findByRole("button", { name: "Register" }));
      await user.type(screen.getByLabelText("Username"), "  an_binh ");
      await user.type(
        screen.getByLabelText("Recovery email"),
        " an@example.com ",
      );
      await user.type(screen.getByLabelText("Password"), " s3cret-pass");
      await user.click(
        screen
          .getAllByRole("button", { name: "Register" })
          .find(
            (button) => button.getAttribute("type") === "submit",
          ) as HTMLElement,
      );

      expect(
        await screen.findByText("No access to the dashboard"),
      ).toBeInTheDocument();
      // The names are trimmed; the password is sent exactly as typed.
      expect(register).toHaveBeenCalledWith({
        password: " s3cret-pass",
        recoveryEmail: "an@example.com",
        username: "an_binh",
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(toast.success).toHaveBeenCalledWith("Account created", {
        description: "You are signed in as an_binh.",
      });
      expect(
        screen.getByText(/The account an_binh is not on the staff list/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Send this username to the shop owner/),
      ).toBeInTheDocument();
    });

    it("lets an owner the server already knows straight in", async () => {
      load
        .mockResolvedValueOnce({ status: "signed-out" })
        .mockResolvedValueOnce(READY);
      register.mockResolvedValue("thuha");
      const user = userEvent.setup();

      renderGate();
      await user.click(await screen.findByRole("button", { name: "Register" }));
      await user.type(screen.getByLabelText("Username"), "thuha");
      await user.type(
        screen.getByLabelText("Recovery email"),
        "thuha@example.com",
      );
      await user.type(screen.getByLabelText("Password"), "s3cret-pass");
      await user.click(
        screen
          .getAllByRole("button", { name: "Register" })
          .find(
            (button) => button.getAttribute("type") === "submit",
          ) as HTMLElement,
      );

      expect(
        await screen.findByText("Inside as thuha (cashier)"),
      ).toBeInTheDocument();
    });

    it("says in a toast why the account was refused, and stays on the form", async () => {
      load.mockResolvedValue({ status: "signed-out" });
      register.mockRejectedValue(
        new ServiceError(
          "That username is already registered.",
          409,
          "username_taken",
        ),
      );
      const user = await openRegister();

      await user.type(screen.getByLabelText("Username"), "thuha");
      await user.type(
        screen.getByLabelText("Recovery email"),
        "thuha@example.com",
      );
      await user.type(screen.getByLabelText("Password"), "s3cret-pass");
      await user.click(
        screen
          .getAllByRole("button", { name: "Register" })
          .find(
            (button) => button.getAttribute("type") === "submit",
          ) as HTMLElement,
      );

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Could not register", {
          description: "That username is already registered.",
        }),
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Username")).toHaveValue("thuha");
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("an account that is not allowed in", () => {
    it("is told so, and offered a way out", async () => {
      load.mockResolvedValue({ status: "forbidden", username: null });

      renderGate();

      expect(
        await screen.findByText("No access to the dashboard"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Ask the shop owner to check/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Inside as/)).not.toBeInTheDocument();
    });

    it("can sign out and try another account", async () => {
      load.mockResolvedValue({ status: "forbidden", username: null });
      const user = userEvent.setup();

      renderGate();
      await screen.findByText("No access to the dashboard");
      await user.click(screen.getByRole("button", { name: "Log out" }));

      expect(await screen.findByText("Dashboard login")).toBeInTheDocument();
      expect(logout).toHaveBeenCalledTimes(1);
    });
  });

  describe("a server that does not answer", () => {
    it("says so, and tries again when asked", async () => {
      load
        .mockResolvedValueOnce({ status: "unavailable" })
        .mockResolvedValueOnce(READY);
      const user = userEvent.setup();

      renderGate();

      expect(
        await screen.findByText("Cannot reach the server"),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(
        await screen.findByText("Inside as thuha (cashier)"),
      ).toBeInTheDocument();
    });
  });

  describe("a session that ends while the dashboard is open", () => {
    it("shows the sign-in form and says why, asking the server once and not again", async () => {
      load.mockResolvedValue(READY);
      const ask = vi.fn(() =>
        Promise.reject(
          new ServiceError("Log in to continue.", 401, "unauthorized"),
        ),
      );

      renderGate(<Failing ask={ask} />);

      expect(await screen.findByText("Dashboard login")).toBeInTheDocument();
      expect(screen.queryByText("Orders page")).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith("Your session has expired", {
        description: "Log in again to continue.",
        id: "session-expired",
      });
      // Giving the page room to ask again, which it must not do.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ask).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it("forgets what the pages fetched", async () => {
      load.mockResolvedValue(READY);

      const queryClient = renderGate();
      await screen.findByText("Inside as thuha (cashier)");
      queryClient.setQueryData(["dashboard", "stock"], ["something private"]);
      queryClient.setQueryData<SessionState>(["dashboard", "session"], {
        status: "signed-out",
      });

      expect(await screen.findByText("Dashboard login")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          queryClient.getQueryData(["dashboard", "stock"]),
        ).toBeUndefined(),
      );
    });
  });

  describe("signing out", () => {
    it("ends the session on the server and shows the sign-in form", async () => {
      load.mockResolvedValue(READY);
      const user = userEvent.setup();

      renderGate();
      await user.click(await screen.findByRole("button", { name: "Leave" }));

      expect(await screen.findByText("Dashboard login")).toBeInTheDocument();
      expect(logout).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Inside as/)).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith("Logged out");
    });

    it("forgets everything fetched as that member of staff", async () => {
      load.mockResolvedValue(READY);
      const user = userEvent.setup();

      const queryClient = renderGate();
      await screen.findByText("Inside as thuha (cashier)");
      queryClient.setQueryData(["dashboard", "stock"], ["something private"]);

      await user.click(screen.getByRole("button", { name: "Leave" }));

      await waitFor(() =>
        expect(
          queryClient.getQueryData(["dashboard", "stock"]),
        ).toBeUndefined(),
      );
    });

    it("still signs out in this browser when the server could not be told", async () => {
      load.mockResolvedValue(READY);
      logout.mockRejectedValue(
        new ServiceError("Không kết nối được tới máy chủ.", null, null),
      );
      const user = userEvent.setup();

      renderGate();
      await user.click(await screen.findByRole("button", { name: "Leave" }));

      expect(await screen.findByText("Dashboard login")).toBeInTheDocument();
      // It does not claim the server heard.
      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(
          "Logged out in this browser only",
          {
            description:
              "The server could not be told: Không kết nối được tới máy chủ.",
          },
        ),
      );
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
