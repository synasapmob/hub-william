import CopyCommand from "@/components/copy-command";
import Flex from "@/components/ui/flex";
import catalogService, { type CatalogCollection } from "@/services/catalog";

const token =
  "rounded-lg border border-zinc-200/80 bg-card px-2 py-1 font-mono text-[11px] text-zinc-800";

interface CatalogCanvasCollectionUsageProps {
  collection: CatalogCollection;
}

function promptFor(invocation: string, collection: CatalogCollection) {
  if (collection.id === "github") {
    return `${invocation} Check the current pull request and apply this workflow.`;
  }

  if (collection.id === "tags") {
    return `${invocation} Handle this request using the selected mode.`;
  }

  return `${invocation} Use this capability for the current request.`;
}

/** How a collection becomes active after the Documents installer places it. */
export default function CatalogCanvasCollectionUsage({
  collection,
}: CatalogCanvasCollectionUsageProps) {
  const invocations = [
    ...new Set(
      collection.entries.flatMap(
        (entry) => catalogService.usage(entry).invocations,
      ),
    ),
  ];

  if (invocations.length > 0) {
    return (
      <div className="space-y-3">
        <p className="text-zinc-600 text-sm/relaxed">
          Install the Documents collection so its dispatcher and source paths
          stay together, then include one of these tokens in the prompt:
        </p>

        <Flex className="items-center gap-2 flex-wrap">
          {invocations.map((invocation) => (
            <code key={invocation} className={token}>
              {invocation}
            </code>
          ))}
        </Flex>

        <CopyCommand command={promptFor(invocations[0]!, collection)} />
      </div>
    );
  }

  if (collection.id === "evidences") {
    return (
      <p className="text-zinc-600 text-sm/relaxed">
        Evidence contracts have no prompt token. The installed AGENTS dispatcher
        loads them automatically before tests, checks and implementation-history
        writes, so copying one file without the dispatcher does not activate it.
      </p>
    );
  }

  if (collection.id === "templates") {
    return (
      <p className="text-zinc-600 text-sm/relaxed">
        Templates are consumed by the workflow that creates the matching
        artifact. Download one for manual use, or install Documents to keep the
        dispatcher and template paths connected.
      </p>
    );
  }

  return (
    <p className="text-zinc-600 text-sm/relaxed">
      This collection is loaded through the installed AGENTS dispatcher when its
      documented action applies; it is not invoked by a standalone tag.
    </p>
  );
}
