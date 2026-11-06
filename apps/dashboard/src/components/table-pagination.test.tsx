import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import TablePagination from "./table-pagination";

const pages = () =>
  screen
    .getAllByRole("button", { name: /^Trang \d+$/ })
    .map((button) => button.textContent);

function renderPagination(page: number, total: number, onPageChange = vi.fn()) {
  render(
    <TablePagination
      page={page}
      pageSize={20}
      total={total}
      unit="đơn"
      onPageChange={onPageChange}
    />,
  );

  return onPageChange;
}

describe("TablePagination", () => {
  it("says which rows are shown", () => {
    renderPagination(2, 45);

    expect(screen.getByText("Hiển thị 21–40 trong 45 đơn")).toBeInTheDocument();
  });

  it("ends the last page at the total, not at a full page", () => {
    renderPagination(3, 45);

    expect(screen.getByText("Hiển thị 41–45 trong 45 đơn")).toBeInTheDocument();
  });

  it("shows every page when there are few, wherever the current one is", () => {
    renderPagination(1, 100);

    expect(pages()).toEqual(["1", "2", "3", "4", "5"]);
    expect(screen.queryByText("…")).not.toBeInTheDocument();
  });

  it("still shows every page at seven, and collapses at eight", () => {
    const { unmount } = render(
      <TablePagination
        page={1}
        pageSize={20}
        total={140}
        unit="đơn"
        onPageChange={() => {}}
      />,
    );

    expect(pages()).toHaveLength(7);

    unmount();
    renderPagination(1, 160);

    expect(pages()).toEqual(["1", "2", "8"]);
  });

  it("collapses the pages far from the current one", () => {
    renderPagination(5, 200);

    expect(pages()).toEqual(["1", "4", "5", "6", "10"]);
    expect(screen.getAllByText("…")).toHaveLength(2);
  });

  it("does not leave a gap where no page is skipped", () => {
    renderPagination(2, 200);

    expect(pages()).toEqual(["1", "2", "3", "10"]);
    expect(screen.getAllByText("…")).toHaveLength(1);
  });

  it("reports the page that was picked", async () => {
    const user = userEvent.setup();
    const onPageChange = renderPagination(2, 100);

    await user.click(screen.getByRole("button", { name: "Trang 4" }));
    await user.click(screen.getByRole("button", { name: "Trang trước" }));
    await user.click(screen.getByRole("button", { name: "Trang sau" }));

    expect(onPageChange.mock.calls).toEqual([[4], [1], [3]]);
  });

  it("disables the arrow that has nowhere to go", () => {
    renderPagination(5, 100);

    expect(screen.getByRole("button", { name: "Trang sau" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Trang trước" })).toBeEnabled();
  });

  it("shows no page controls for a single page", () => {
    renderPagination(1, 12);

    expect(screen.getByText("Hiển thị 1–12 trong 12 đơn")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("renders nothing when there are no rows", () => {
    const { container } = render(
      <TablePagination
        page={1}
        pageSize={20}
        total={0}
        unit="đơn"
        onPageChange={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
