import type { PropsWithChildren } from "react";

import Flex from "@/components/ui/flex";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface StockToggleSectionProps extends PropsWithChildren {
  checked: boolean;
  /** Holds the switch where it is, when something else has to be dealt with first. */
  disabled?: boolean;
  id: string;
  label: string;
  onCheckedChange: (next: boolean) => void;
}

/** A part of the form that stays off until it is turned on, and shows its fields only then. */
export default function StockToggleSection({
  checked,
  children,
  disabled,
  id,
  label,
  onCheckedChange,
}: StockToggleSectionProps) {
  return (
    <div className="space-y-2">
      <Flex className="items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>

        <Switch
          checked={checked}
          disabled={disabled}
          id={id}
          onCheckedChange={onCheckedChange}
        />
      </Flex>

      {checked && children}
    </div>
  );
}
