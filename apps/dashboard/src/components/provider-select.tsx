import { Plus } from "lucide-react";

import ProviderIcon from "@/components/provider-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ProviderOption {
  /** What the form keeps when the agent is chosen. */
  value: string;
  /** What the person reads. */
  label: string;
  /** The agent's id, to find its icon by. */
  icon: string;
}

interface ProviderSelectProps {
  id: string;
  value: string;
  options: ProviderOption[];
  /** One more choice after the agents, with a plus beside it: to add one that is not in the list. */
  extra?: { value: string; label: string };
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  /** The agent can no longer be changed. */
  disabled?: boolean;
}

/** The agents Hub William supports, to pick one from: a fixed list, not typed. */
export default function ProviderSelect({
  disabled,
  extra,
  id,
  invalid,
  onChange,
  options,
  placeholder = "Chọn nhà cung cấp",
  value,
}: ProviderSelectProps) {
  return (
    <Select disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger aria-invalid={invalid} className="w-full" id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>

      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {/* The icon is for the eye; the agent's name is what the option is called. */}
            <span aria-hidden={true} className="contents">
              <ProviderIcon provider={option.icon} size="sm" />
            </span>

            {option.label}
          </SelectItem>
        ))}

        {extra && (
          <>
            <SelectSeparator />

            <SelectItem value={extra.value}>
              <Plus aria-hidden={true} className="size-4" />

              {extra.label}
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
