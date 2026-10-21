import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { catalogueLabel } from "@/services/catalog/catalog-collections";

const catalogueTab = tv({
  base: "rounded-lg px-3 py-1.5 font-mono text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    current: {
      true: "bg-zinc-900 font-medium text-white",
      false: "text-muted-foreground hover:bg-slate-100 hover:text-foreground",
    },
  },
});

interface ToolsCatalogSwitchProps {
  catalogues: string[];
  current: string | null;
  onSelect: (catalogue: string) => void;
}

/** One tab per folder a contributor publishes: tools, skills, scripts. */
export default function ToolsCatalogSwitch({
  catalogues,
  current,
  onSelect,
}: ToolsCatalogSwitchProps) {
  return (
    <Flex
      role="group"
      aria-label="Catalogue sections"
      className="items-center gap-1.5 border-b border-slate-200/80 bg-card/95 px-5 py-2"
    >
      {catalogues.map((catalogue) => (
        <button
          key={catalogue}
          type="button"
          aria-pressed={catalogue === current}
          onClick={() => onSelect(catalogue)}
          className={catalogueTab({ current: catalogue === current })}
        >
          {catalogueLabel(catalogue)}
        </button>
      ))}
    </Flex>
  );
}
