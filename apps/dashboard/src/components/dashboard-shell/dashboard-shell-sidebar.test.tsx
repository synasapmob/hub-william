import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { roleLabels } from "@/services/sales/sales-labels";
import type { Role } from "@/services/sales/sales-types";
import renderPage from "@/test/render-page";

import DashboardShellSidebar from "./dashboard-shell-sidebar";

function shown(role: Role) {
  renderPage(<DashboardShellSidebar />, role);

  return screen.getAllByRole("link").map((link) => link.textContent);
}

describe("DashboardShellSidebar", () => {
  it("lists every page for the owner", () => {
    expect(shown("owner")).toEqual(
      expect.arrayContaining([
        "Inventory",
        "Orders",
        "Sales history",
        "Revenue",
        "Staff",
      ]),
    );
  });

  it("names the two groups in English", () => {
    renderPage(<DashboardShellSidebar />, "owner");

    expect(
      screen.getByRole("navigation", { name: "Shop" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Management" }),
    ).toBeInTheDocument();
  });

  it("keeps the staff page from a manager", () => {
    const names = shown("manager");

    expect(names).toContain("Revenue");
    expect(names).not.toContain("Staff");
  });

  it("gives a cashier the orders and history, and nothing about money or stock", () => {
    const names = shown("cashier");

    expect(names).toEqual(expect.arrayContaining(["Orders", "Sales history"]));
    expect(names).not.toContain("Revenue");
    expect(names).not.toContain("Inventory");
  });

  it("gives a stock keeper the stock page alone, and no empty group", () => {
    renderPage(<DashboardShellSidebar />, "stock-keeper");

    const groups = screen.getAllByRole("navigation");

    expect(groups).toHaveLength(1);
    expect(
      within(groups[0])
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Inventory"]);
  });

  it("shows who is signed in and their role", () => {
    renderPage(<DashboardShellSidebar />, "cashier");

    expect(screen.getByText("thuha")).toBeInTheDocument();
    expect(screen.getByText(roleLabels.cashier)).toBeInTheDocument();
  });
});
