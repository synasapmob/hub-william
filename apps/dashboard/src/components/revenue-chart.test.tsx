import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import RevenueChart, { type RevenuePoint } from "./revenue-chart";

const points: RevenuePoint[] = [
  { date: "2026-11-03", orders: 4, total: 800_000 },
  { date: "2026-11-04", orders: 9, total: 2_100_000 },
  { date: "2026-11-05", orders: 5, total: 1_000_000 },
];

describe("RevenueChart", () => {
  it("draws one column per day, each named by its date and takings", () => {
    render(<RevenueChart points={points} type="telegram" />);

    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: /04\/11: 2\.100\.000\s₫, 9 đơn/ }),
    ).toBeInTheDocument();
  });

  it("says which day was best", () => {
    render(<RevenueChart points={points} type="telegram" />);

    expect(
      screen.getByText(/Cao nhất 2\.100\.000\s₫ · 04\/11/),
    ).toBeInTheDocument();
  });

  it("shows the tooltip on hover and on keyboard focus, and hides it after", async () => {
    const user = userEvent.setup();

    render(<RevenueChart points={points} type="telegram" />);

    expect(screen.queryByText(/ · 9 đơn/)).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: /04\/11/ }));

    expect(screen.getByText("04/11 · 9 đơn")).toBeInTheDocument();

    await user.unhover(screen.getByRole("button", { name: /04\/11/ }));

    expect(screen.queryByText("04/11 · 9 đơn")).not.toBeInTheDocument();

    act(() => screen.getByRole("button", { name: /03\/11/ }).focus());

    expect(screen.getByText("03/11 · 4 đơn")).toBeInTheDocument();
  });

  it("keeps every number reachable in a table", async () => {
    const user = userEvent.setup();

    render(<RevenueChart points={points} type="telegram" />);
    await user.click(screen.getByRole("tab", { name: "Bảng" }));

    expect(screen.getByRole("table")).toBeInTheDocument();
    // Four rows with the header; the latest day comes first.
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("05/11");
  });

  it("writes Hub William takings in dollars", () => {
    render(
      <RevenueChart
        points={[{ date: "2026-11-05", orders: 2, total: 30_000_000 }]}
        type="hub-william"
      />,
    );

    expect(screen.getByText(/Cao nhất \$30\.00/)).toBeInTheDocument();
  });

  it("says so when there is nothing to draw", () => {
    render(<RevenueChart points={[]} type="telegram" />);

    expect(screen.getByText(/Chưa có doanh thu/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
