import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import WorkspaceShellAuthDialog from "./workspace-shell-auth-dialog";

describe("WorkspaceShellAuthDialog", () => {
  it("registers with username, password, and the future recovery email field", async () => {
    const user = userEvent.setup();
    const authenticate = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkspaceShellAuthDialog
        open
        onAuthenticate={authenticate}
        onOpenChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Register" }));
    await user.type(screen.getByLabelText("Username"), "newmember");
    await user.type(screen.getByLabelText("Recovery email"), "new@gmail.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(authenticate).toHaveBeenCalledWith("register", {
      password: "password123",
      recoveryEmail: "new@gmail.com",
      username: "newmember",
    });
  });
});
