import { tv } from "tailwind-variants";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AccountStatusFilter } from "@/services/stock/stock-service";

// "Tất cả" comes first and is what the page starts on.
const STATUS_TABS: { value: AccountStatusFilter; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "unsold", label: "Chưa bán" },
  { value: "sold", label: "Đã bán" },
];

// The same look as the filter of the orders page.
const filter = tv({
  slots: {
    list: "gap-1 rounded-xl p-1 group-data-horizontal/tabs:h-auto",
    trigger:
      "h-auto flex-none gap-2 rounded-lg px-4 py-2 text-muted-foreground data-active:bg-blue-600 data-active:text-white data-active:shadow-sm data-active:hover:text-white",
    count:
      "min-w-5 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums",
  },
  variants: {
    active: {
      true: { count: "bg-white/20 text-white" },
      false: { count: "bg-zinc-200/70 text-zinc-700" },
    },
  },
});

interface AccountsStatusFilterProps {
  value: AccountStatusFilter;
  /** How many accounts each tab would show, under the search; unknown until loaded. */
  counts: Record<AccountStatusFilter, number> | undefined;
  onValueChange: (value: AccountStatusFilter) => void;
}

export default function AccountsStatusFilter({
  counts,
  onValueChange,
  value,
}: AccountsStatusFilterProps) {
  const { count, list, trigger } = filter();

  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as AccountStatusFilter)}
    >
      <TabsList className={list()}>
        {STATUS_TABS.map((tab) => (
          <TabsTrigger key={tab.value} className={trigger()} value={tab.value}>
            {tab.label}

            {counts && (
              <span className={count({ active: tab.value === value })}>
                {counts[tab.value]}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
