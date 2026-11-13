import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stockTypeLabels } from "@/services/sales/sales-labels";
import type { StockType } from "@/services/sales/sales-types";

interface PlatformSelectProps {
  id: string;
  value: StockType;
  /** The platform cannot be changed while something is being saved. */
  disabled?: boolean;
  onChange: (type: StockType) => void;
}

/**
 * Where a new item is sold: Telegram and Hub William are two stocks, each with its
 * own form, so choosing the other one swaps the form.
 */
export default function PlatformSelect({
  disabled,
  id,
  onChange,
  value,
}: PlatformSelectProps) {
  return (
    <Select
      disabled={disabled}
      value={value}
      onValueChange={(next) => onChange(next as StockType)}
    >
      <SelectTrigger className="w-full" id={id}>
        <SelectValue />
      </SelectTrigger>

      <SelectContent>
        {(Object.keys(stockTypeLabels) as StockType[]).map((type) => (
          <SelectItem key={type} value={type}>
            {stockTypeLabels[type]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
