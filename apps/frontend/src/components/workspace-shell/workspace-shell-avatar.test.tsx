import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WorkspaceShellAvatar from "./workspace-shell-avatar";

let githubAvailable = false;
let loadedImages: string[] = [];
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  githubAvailable = false;
  loadedImages = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "Image",
    class extends EventTarget {
      complete = false;
      naturalWidth = 0;
      set src(value: string) {
        queueMicrotask(() => {
          this.complete = true;
          this.naturalWidth = githubAvailable ? 32 : 0;
          loadedImages.push(value);
          this.dispatchEvent(new Event(this.naturalWidth ? "load" : "error"));
        });
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads the GitHub avatar directly without a Hub API lookup", async () => {
  githubAvailable = true;
  render(
    <WorkspaceShellAvatar
      user={{ id: "first", username: "github-user", recoveryEmail: null }}
    />,
  );
  expect(
    await screen.findByRole("img", { name: "github-user" }),
  ).toHaveAttribute("src", "https://github.com/github-user.png?size=64");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("keeps initials after an image failure without an API fallback", async () => {
  render(
    <WorkspaceShellAvatar
      user={{ id: "first", username: "missing", recoveryEmail: null }}
    />,
  );
  await waitFor(() =>
    expect(loadedImages).toContain("https://github.com/missing.png?size=64"),
  );
  expect(await screen.findByText("mis")).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("uses initials for an invalid GitHub username without requesting an image", () => {
  render(
    <WorkspaceShellAvatar
      user={{ id: "first", username: "hub_user", recoveryEmail: null }}
    />,
  );
  expect(screen.getByText("hub")).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(loadedImages).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("tries the new user's image after the previous user's image failed", async () => {
  const first = render(
    <WorkspaceShellAvatar
      user={{ id: "first", username: "missing", recoveryEmail: null }}
    />,
  );
  await waitFor(() =>
    expect(loadedImages).toContain("https://github.com/missing.png?size=64"),
  );
  expect(await screen.findByText("mis")).toBeVisible();
  githubAvailable = true;
  first.rerender(
    <WorkspaceShellAvatar
      user={{ id: "second", username: "someone", recoveryEmail: null }}
    />,
  );
  expect(await screen.findByRole("img", { name: "someone" })).toHaveAttribute(
    "src",
    "https://github.com/someone.png?size=64",
  );
  expect(screen.queryByText("mis")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
