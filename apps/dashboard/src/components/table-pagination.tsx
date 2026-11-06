import { ChevronLeft, ChevronRight } from "lucide-react";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";

const pageButton = tv({
  base: "tabular-nums",
  variants: {
    current: {
      true: "border-blue-600 bg-blue-600 text-white hover:bg-blue-600/90 hover:text-white",
    },
  },
});

// Up to this many pages are all shown; past it, only the ends and the current.
const SHOW_ALL_UP_TO = 7;

// Pages to show: every one when there are few, else the first, the last and the
// ones around the current, with a gap wherever pages are left out.
function pageItems(page: number, pageCount: number) {
  if (pageCount <= SHOW_ALL_UP_TO)
    return Array.from({ length: pageCount }, (_, index) => index + 1);

  const pages = [...new Set([1, pageCount, page - 1, page, page + 1])]
    .filter((candidate) => candidate >= 1 && candidate <= pageCount)
    .sort((a, b) => a - b);

  return pages.flatMap((candidate, index) =>
    index > 0 && candidate - pages[index - 1] > 1
      ? ["gap" as const, candidate]
      : [candidate],
  );
}

interface TablePaginationProps {
  /** The current page, counting from 1. */
  page: number;
  pageSize: number;
  total: number;
  /** What the rows are called, for "1–20 of 100 orders". */
  unit: string;
  onPageChange: (page: number) => void;
}

/** "Hiển thị 1–20 trong 100 đơn", and the pages to move between. */
export default function TablePagination({
  onPageChange,
  page,
  pageSize,
  total,
  unit,
}: TablePaginationProps) {
  const pageCount = Math.ceil(total / pageSize);
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  if (total === 0) return null;

  return (
    <Flex className="flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Hiển thị {first}–{last} trong {total} {unit}
      </p>

      {pageCount > 1 && (
        <nav aria-label="Phân trang">
          <Flex className="items-center gap-1">
            <Button
              aria-label="Trang trước"
              disabled={page === 1}
              size="icon-lg"
              variant="outline"
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft />
            </Button>

            {pageItems(page, pageCount).map((item, index) =>
              item === "gap" ? (
                <span
                  key={`gap-${index}`}
                  className="px-1 text-sm text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <Button
                  key={item}
                  aria-current={item === page ? "page" : undefined}
                  aria-label={`Trang ${item}`}
                  className={pageButton({ current: item === page })}
                  size="icon-lg"
                  variant="outline"
                  onClick={() => onPageChange(item)}
                >
                  {item}
                </Button>
              ),
            )}

            <Button
              aria-label="Trang sau"
              disabled={page === pageCount}
              size="icon-lg"
              variant="outline"
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRight />
            </Button>
          </Flex>
        </nav>
      )}
    </Flex>
  );
}
