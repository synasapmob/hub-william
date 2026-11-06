import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { tv } from "tailwind-variants";

import Panel from "@/components/panel";
import Flex from "@/components/ui/flex";

const delta = tv({
  base: "items-center gap-0.5 text-xs font-medium",
  variants: {
    direction: {
      up: "text-emerald-700",
      down: "text-rose-700",
    },
  },
});

interface StatCardProps {
  label: string;
  value: string;
  /** Change against the previous period, in percent; up is good. */
  change?: number;
  hint?: string;
}

export default function StatCard({
  change,
  hint,
  label,
  value,
}: StatCardProps) {
  return (
    <Panel className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>

      <p className="text-xl font-semibold tracking-tight">{value}</p>

      {change !== undefined && (
        <Flex className={delta({ direction: change >= 0 ? "up" : "down" })}>
          {change >= 0 ? (
            <ArrowUpRight aria-hidden={true} className="size-3.5" />
          ) : (
            <ArrowDownRight aria-hidden={true} className="size-3.5" />
          )}
          {change >= 0 ? "+" : "−"}
          {Math.abs(change).toFixed(1).replace(".", ",")}% so với kỳ trước
        </Flex>
      )}

      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Panel>
  );
}
