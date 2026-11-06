import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stockTypeLabels } from "@/services/sales/sales-labels";
import type { StockType } from "@/services/sales/sales-types";

export type StockTypeFilterValue = StockType | "all";

interface StockTypeFilterProps {
  value: StockTypeFilterValue;
  onValueChange: (value: StockTypeFilterValue) => void;
}

/** Which side of the business the stock list shows: every type, or one. */
export default function StockTypeFilter({
  onValueChange,
  value,
}: StockTypeFilterProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as StockTypeFilterValue)}
    >
      <SelectTrigger
        aria-label="Lọc theo loại"
        className="w-44 data-[size=default]:h-10"
      >
        <SelectValue />
      </SelectTrigger>

      <SelectContent>
        <SelectItem value="all">Mọi loại</SelectItem>

        <SelectItem value="telegram">{stockTypeLabels.telegram}</SelectItem>

        <SelectItem value="hub-william">
          {stockTypeLabels["hub-william"]}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
