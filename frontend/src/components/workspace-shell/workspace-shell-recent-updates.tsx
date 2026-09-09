import { Link } from "react-router";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import catalogService, {
  collectionIdForEntry,
  type CatalogEntry,
} from "@/services/catalog";

/**
 * Who changed what in the catalogue lately — fixture data, like `/activities`.
 *
 * Nothing in the build knows when a document changed. `import.meta.glob` hands
 * the service the bytes of each file and not its mtime, and no step reads git
 * history, so there is no timestamp anywhere to derive this from. It stays a
 * fixture until a build-time git step exists to write one.
 *
 * What is not invented is the document. Each row names an entry by the slug a
 * `?node=` link carries, and the catalogue is asked for it at module scope, so
 * a row whose file was renamed or removed drops out of the list rather than
 * linking at nothing.
 */
interface CatalogUpdate {
  /** The GitHub login the avatar and the sentence are built from. */
  login: string;
  /** The entry's `?node=` slug: its path under the catalogue, slashes flattened. */
  slug: string;
  /**
   * A fixed phrase, never a clock.
   *
   * Every route is prerendered, so a relative time computed at render disagrees
   * with the HTML that shipped and React reports it as a hydration failure.
   */
  updatedAgo: string;
}

const catalogUpdates: CatalogUpdate[] = [
  {
    login: "synasapmob",
    slug: "contributors-default-libraries-harness-tags-report",
    updatedAgo: "today",
  },
  {
    login: "synasapmob",
    slug: "contributors-synasapmob-libraries-harness-dopa-tps",
    updatedAgo: "2 days ago",
  },
  {
    login: "synasapmob",
    slug: "contributors-synasapmob-libraries-harness-projects-routing",
    updatedAgo: "4 days ago",
  },
];

interface ResolvedUpdate extends CatalogUpdate {
  entry: CatalogEntry;
}

const resolvedUpdates: ResolvedUpdate[] = catalogUpdates.flatMap((update) => {
  const entry = catalogService.findBySlug(update.slug);

  return entry ? [{ ...update, entry }] : [];
});

/**
 * The collection that contains this document.
 *
 * `?node=` is what `_app.library.($contributor)/route.tsx` reads back, and a
 * workspace contract is only drawn on its owner's canvas — `/library` publishes
 * the shared catalogue alone, so a contributor's entry has to be addressed
 * through their page or the sheet opens over a tree it is not in.
 */
function entryHref(entry: CatalogEntry) {
  const catalogue = entry.contributor
    ? `/library/${entry.contributor}`
    : "/library";

  return `${catalogue}?node=${collectionIdForEntry(entry)}`;
}

interface WorkspaceShellRecentUpdatesProps {
  onNavigate?: () => void;
}

export default function WorkspaceShellRecentUpdates({
  onNavigate,
}: WorkspaceShellRecentUpdatesProps) {
  if (resolvedUpdates.length === 0) return null;

  return (
    // The list scrolls rather than the sidebar: navigation is the thing a
    // reader came for, and it has to stay on screen on a short viewport.
    <section
      aria-label="Recent catalogue updates"
      className="mt-6 flex min-h-0 flex-col"
    >
      <p className="px-2 pb-2 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        Recent updates
      </p>

      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {resolvedUpdates.map(({ entry, login, updatedAgo }) => (
          <li key={entry.id}>
            <Link
              to={entryHref(entry)}
              onClick={onNavigate}
              className="flex w-full items-start gap-2.5 rounded-lg transition-colors p-2 hover:bg-zinc-100/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <Avatar size="sm" className="mt-0.5">
                <AvatarImage
                  src={`https://github.com/${login}.png?size=64`}
                  alt=""
                />
                <AvatarFallback className="bg-zinc-100 text-zinc-700">
                  {login.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>

              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground">{login}</span>{" "}
                  updated{" "}
                  <span className="font-medium text-foreground">
                    {entry.name}
                  </span>
                </p>

                <p className="mt-0.5 font-mono text-[10px] text-zinc-400">
                  {updatedAgo}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
