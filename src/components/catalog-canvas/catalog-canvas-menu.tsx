import { useState } from "react";
import { Boxes, Check, ChevronDown, Search } from "lucide-react";
import { Link } from "react-router";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import catalogService, { type CatalogSection } from "@/services/catalog";

const menuItem = tv({
  base: "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    current: {
      true: "bg-muted font-medium text-foreground",
      false: "text-muted-foreground hover:bg-accent hover:text-foreground",
    },
  },
});

interface CatalogCanvasMenuProps {
  /** Whose catalogue is open, or null for the shared one. */
  contributor: string | null;
  /** Which canvas the links stay on, so Tools does not send you to Library. */
  section: CatalogSection;
}

/**
 * Which catalogue is being read, and how to reach another one.
 *
 * A popover with its own search field rather than a dropdown menu: a menu
 * treats typing as type-ahead and eats the keystrokes, and this list grows by
 * one every time somebody contributes.
 *
 * A contributor's folder name is their GitHub login — that is the convention,
 * and it is what makes `https://github.com/<login>.png` their avatar without
 * an API call or a stored file. The initial stays as the fallback, which is
 * what shows when the login is wrong, the image is blocked, or the reader is
 * offline.
 */
export default function CatalogCanvasMenu({
  contributor,
  section,
}: CatalogCanvasMenuProps) {
  const base = `/${section}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const term = query.trim().toLowerCase();
  const matches = catalogService
    .contributors(section)
    .filter((name) => name.toLowerCase().includes(term));

  function close() {
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-xl border border-border bg-muted px-3 py-2 font-mono text-sm font-medium text-foreground/80 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <Boxes aria-hidden="true" className="size-4" />
          Contributors
          <span className="text-muted-foreground">
            {contributor ? `@${contributor}` : "@Default"}
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />

          <Input
            type="search"
            value={query}
            aria-label="Search catalogues"
            placeholder="Search contributors..."
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 rounded-lg bg-muted pl-8 text-sm"
          />
        </div>

        <div className="mt-2 max-h-80 overflow-y-auto">
          {/* The shared catalogue is always reachable, and is not filtered out
              by a search for somebody's name — it is the way back. */}
          <Link
            to={base}
            onClick={close}
            className={menuItem({ current: contributor === null })}
          >
            <Avatar size="sm">
              <AvatarFallback className="bg-indigo-500/10 text-indigo-300">
                <Boxes aria-hidden="true" className="size-3" />
              </AvatarFallback>
            </Avatar>

            <span className="flex-1">
              All
              <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                by system
              </span>
            </span>

            {contributor === null ? (
              <Check aria-hidden="true" className="size-3.5 text-indigo-400" />
            ) : null}
          </Link>

          {matches.length > 0 ? (
            <p className="mt-2 px-2 pb-1 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
              Contributors
            </p>
          ) : null}

          {matches.map((name) => (
            <Link
              key={name}
              to={`${base}/${name}`}
              onClick={close}
              className={menuItem({ current: contributor === name })}
            >
              <Avatar size="sm">
                <AvatarImage
                  src={`https://github.com/${name}.png?size=64`}
                  alt=""
                />
                <AvatarFallback className="bg-muted text-muted-foreground">
                  {name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>

              <span className="flex-1 truncate">{name}</span>

              <span className="font-mono text-[11px] text-muted-foreground">
                {catalogService.documentCount(section, name)}
              </span>

              {contributor === name ? (
                <Check
                  aria-hidden="true"
                  className="size-3.5 text-indigo-400"
                />
              ) : null}
            </Link>
          ))}

          {term && matches.length === 0 ? (
            <Flex className="items-center justify-center gap-3 px-2 py-6">
              <p className="text-xs text-muted-foreground">
                No contributor matches “{query}”.
              </p>
            </Flex>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
