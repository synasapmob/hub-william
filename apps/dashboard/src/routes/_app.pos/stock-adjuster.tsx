import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StockAdjusterProps {
  label: string;
  /** What is counted: "gói", "triệu token". */
  unit: string;
  /** The signed amount to add, as typed. */
  value: string;
  invalid: boolean;
  /** What the amount comes to, or why it is refused. */
  hint: string;
  onChange: (value: string) => void;
}

/** Add to or take from a stock count: a stepper around a number typed freely. */
export default function StockAdjuster({
  hint,
  invalid,
  label,
  onChange,
  unit,
  value,
}: StockAdjusterProps) {
  const amount = Number(value);
  const step = (delta: number) =>
    onChange(String((Number.isFinite(amount) ? amount : 0) + delta));

  return (
    <div className="space-y-2">
      <Label htmlFor="stock-adjust">{label}</Label>

      <Flex className="flex-wrap items-center gap-2">
        <Button
          aria-label="Giảm 1"
          size="icon"
          variant="outline"
          onClick={() => step(-1)}
        >
          <Minus />
        </Button>

        <Input
          aria-invalid={invalid}
          className="w-24 text-center tabular-nums"
          id="stock-adjust"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />

        <Button
          aria-label="Tăng 1"
          size="icon"
          variant="outline"
          onClick={() => step(1)}
        >
          <Plus />
        </Button>

        <span className="text-sm text-muted-foreground">{unit}</span>
      </Flex>

      <p
        className={
          invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
      >
        {hint}
      </p>
    </div>
  );
}
