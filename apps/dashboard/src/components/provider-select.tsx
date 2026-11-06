import ProviderIcon from "@/components/provider-icon";
import {
  Select,
  SelectContent,
  SelectItem,
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
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  /** The agent can no longer be changed. */
  disabled?: boolean;
}

/** The agents Hub William supports, to pick one from: a fixed list, not typed. */
export default function ProviderSelect({
  disabled,
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
              <ProviderIcon
                label={option.label}
                provider={option.icon}
                size="sm"
              />
            </span>

            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
