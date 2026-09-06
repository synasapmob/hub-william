import Flex from "@/components/ui/flex";
import catalogService, { type CatalogEntry } from "@/services/catalog";

const prose = "text-zinc-600 text-xs/relaxed";

const token =
  "rounded-lg border border-zinc-200/80 bg-card px-2 py-1 font-mono text-[11px] text-zinc-800";

interface CatalogCanvasEntryUsageProps {
  entry: CatalogEntry;
}

/**
 * What this document is for, in the terms a reader acts on.
 *
 * A tag contract is used by typing one of its tags, so the tags are the answer
 * and they are printed as the tokens they are. Everything comes from the
 * document: a contract that defines three modes shows three, and it shows them
 * again the day somebody adds a fourth, because the headings it announces them
 * with are the same headings read here.
 *
 * A contract nothing is typed to reach shows what it covers instead. That is a
 * weaker answer, and it is the honest one — for these there is no command, and
 * a sentence explaining that they load on their own tells a reader nothing they
 * can do.
 */
export default function CatalogCanvasEntryUsage({
  entry,
}: CatalogCanvasEntryUsageProps) {
  const { invocations, sections } = catalogService.usage(entry);

  if (invocations.length > 0) {
    return (
      <Flex className="items-center gap-2 flex-wrap">
        {invocations.map((invocation) => (
          <code key={invocation} className={token}>
            {invocation}
          </code>
        ))}
      </Flex>
    );
  }

  if (sections.length > 0) {
    return (
      <div className="space-y-2">
        <p className={prose}>What it covers:</p>

        <ul className="list-disc space-y-1 pl-4 marker:text-zinc-300">
          {sections.map((section) => (
            <li key={section} className={prose}>
              {section}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <p className={prose}>
      One contract with no sections and nothing to type — the document below is
      all of it.
    </p>
  );
}
