import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import NavigationProgress from "./navigation-progress";

function TestLayout() {
  return (
    <>
      <NavigationProgress />

      <Outlet />
    </>
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("NavigationProgress", () => {
  it("tracks lazy page loading, completion and cached history navigation", async () => {
    const page = deferred();
    const router = createMemoryRouter([
      {
        Component: TestLayout,
        children: [
          { path: "/", element: <h1>Home</h1> },
          {
            path: "/agents",
            lazy: async () => {
              await page.promise;
              return { Component: () => <h1>Agents</h1> };
            },
          },
        ],
      },
    ]);
    render(<RouterProvider router={router} />);
    expect(screen.queryByRole("progressbar")).toBeNull();

    let navigation!: Promise<void>;
    await act(async () => {
      navigation = router.navigate("/agents");
    });

    expect(
      screen.getByRole("progressbar", { name: "Loading page" }),
    ).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("heading", { name: "Home" })).toBeVisible();

    await act(async () => {
      page.resolve();
      await navigation;
    });

    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();

    await act(() => router.navigate(-1));
    expect(screen.getByRole("heading", { name: "Home" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();

    await act(() => router.navigate(1));
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    router.dispose();
  });

  it("clears an interrupted navigation and does not revive it when old work finishes", async () => {
    const page = deferred();
    const router = createMemoryRouter([
      {
        Component: TestLayout,
        children: [
          { path: "/", element: <h1>Home</h1> },
          {
            path: "/agents",
            loader: () => page.promise.then(() => null),
            element: <h1>Agents</h1>,
          },
          { path: "/tools", element: <h1>Tools</h1> },
        ],
      },
    ]);
    render(<RouterProvider router={router} />);

    let navigation!: Promise<void>;
    await act(async () => {
      navigation = router.navigate("/agents");
    });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    await act(() => router.navigate("/tools"));
    expect(screen.getByRole("heading", { name: "Tools" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();

    await act(async () => {
      page.resolve();
      await navigation;
    });
    expect(screen.getByRole("heading", { name: "Tools" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    router.dispose();
  });

  it("stops when navigation reaches an error boundary", async () => {
    const page = deferred();
    const router = createMemoryRouter([
      {
        Component: TestLayout,
        children: [
          { path: "/", element: <h1>Home</h1> },
          {
            path: "/agents",
            loader: async () => {
              await page.promise;
              throw new Response("Unavailable", { status: 503 });
            },
            element: <h1>Agents</h1>,
            errorElement: <h1>Unable to load agents</h1>,
          },
        ],
      },
    ]);
    render(<RouterProvider router={router} />);

    let navigation!: Promise<void>;
    await act(async () => {
      navigation = router.navigate("/agents");
    });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    await act(async () => {
      page.resolve();
      await navigation;
    });
    expect(
      screen.getByRole("heading", { name: "Unable to load agents" }),
    ).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    router.dispose();
  });

  it("does not treat a same-page query or hash change as page loading", async () => {
    const query = deferred();
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [
            {
              id: "tools",
              path: "/tools",
              loader: () => query.promise.then(() => null),
              element: <h1>Tools</h1>,
            },
          ],
        },
      ],
      {
        initialEntries: ["/tools"],
        hydrationData: { loaderData: { tools: null } },
      },
    );
    render(<RouterProvider router={router} />);

    let navigation!: Promise<void>;
    await act(async () => {
      navigation = router.navigate("/tools?node=gateway");
    });
    expect(router.state.navigation.state).toBe("loading");
    expect(screen.queryByRole("progressbar")).toBeNull();

    await act(async () => {
      query.resolve();
      await navigation;
    });
    await act(() => router.navigate("/tools?node=gateway#files"));
    expect(screen.queryByRole("progressbar")).toBeNull();
    router.dispose();
  });
});
