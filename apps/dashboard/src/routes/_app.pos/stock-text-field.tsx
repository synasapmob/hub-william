import { tv } from "tailwind-variants";

import { Textarea } from "@/components/ui/textarea";

const counter = tv({
  base: "text-right text-xs tabular-nums",
  variants: {
    invalid: {
      true: "text-destructive",
      false: "text-muted-foreground",
    },
  },
});

interface StockTextFieldProps {
  /** The name of the field, since the switch above it carries the visible label. */
  label: string;
  /** How much is written, counted as the server counts it. */
  length: number;
  max: number;
  placeholder: string;
  /** Said under the field when it is longer than `max`. */
  problem: string;
  rows: number;
  value: string;
  onChange: (next: string) => void;
}

/** A text box that counts what is written against the most the server keeps. */
export default function StockTextField({
  label,
  length,
  max,
  onChange,
  placeholder,
  problem,
  rows,
  value,
}: StockTextFieldProps) {
  const valid = length <= max;

  return (
    <div className="space-y-1.5">
      <Textarea
        aria-invalid={!valid}
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />

      {length > 0 && (
        <p className={counter({ invalid: !valid })}>
          {length}/{max}
        </p>
      )}

      {!valid && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}
