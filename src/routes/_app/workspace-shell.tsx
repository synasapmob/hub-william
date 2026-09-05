import { useState, type ComponentType } from "react";
import { Activity, Layers, Menu } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router";
import { tv } from "tailwind-variants";

import Flex from "@/components/flex";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

interface NavigationItem {
  href: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  /** What the mobile switcher shows, where two full labels do not fit. */
  shortLabel: string;
}

const navigationItems: NavigationItem[] = [
  {
    href: "/library",
    icon: Layers,
    label: "Agent library",
    shortLabel: "Library",
  },
  {
    href: "/activities",
    icon: Activity,
    label: "Agent activities",
    shortLabel: "Activities",
  },
];

const navigationLinkVariants = tv({
  base: "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "bg-zinc-900 text-white shadow-xs",
      false: "text-muted-foreground hover:bg-zinc-100/80 hover:text-foreground",
    },
  },
});

const navigationIconVariants = tv({
  base: "size-4",
  variants: {
    active: { true: "text-white", false: "text-zinc-500" },
  },
});

/** The mobile header's two-up switcher. Its own table: no sidebar link shares this state. */
const mobileTabVariants = tv({
  base: "rounded-md px-2.5 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "bg-white font-semibold text-foreground shadow-xs",
      false: "text-muted-foreground",
    },
  },
});

interface WorkspaceBrandProps {
  onNavigate?: () => void;
}

function WorkspaceBrand({ onNavigate }: WorkspaceBrandProps) {
  return (
    <Link
      to="/"
      onClick={onNavigate}
      className="flex items-center gap-2.5 rounded-lg text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <div className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-zinc-900 font-mono text-xs font-bold tracking-tighter text-white shadow-xs">
        W
        <div className="pointer-events-none absolute inset-0.5 rounded-md border border-white/20" />
      </div>

      {/* The version sits against the far edge rather than beside the name: it
          is a fact about the workspace, not part of what it is called. */}
      <div className="min-w-0 flex-1">
        <p className="flex items-center justify-between gap-2 text-xs font-semibold tracking-wider uppercase">
          Hub-William
          <span className="rounded border border-zinc-200/80 bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">
            v1.4
          </span>
        </p>
        <p className="text-[11px] tracking-tight text-muted-foreground">
          AI Agent Workspace
        </p>
      </div>
    </Link>
  );
}

interface WorkspaceNavigationProps {
  onNavigate?: () => void;
}

function WorkspaceNavigation({ onNavigate }: WorkspaceNavigationProps) {
  return (
    <nav aria-label="Workspace" className="grid gap-1">
      <p className="px-2 pb-2 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        Workspace
      </p>

      {navigationItems.map((item) => {
        const Icon = item.icon;

        return (
          <NavLink
            key={item.href}
            to={item.href}
            onClick={onNavigate}
            className={({ isActive }) =>
              navigationLinkVariants({ active: isActive })
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  aria-hidden={true}
                  className={navigationIconVariants({ active: isActive })}
                />
                <span className="uppercase">{item.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

interface WorkspaceSidebarProps {
  onNavigate?: () => void;
}

/**
 * One sidebar, rendered by the persistent aside and by the mobile drawer.
 *
 * It is a module-level component rather than markup held in a variable: the two
 * parents are different elements, so a shared variable would remount the whole
 * subtree — and its focus — every time the drawer opened.
 */
function WorkspaceSidebar({ onNavigate }: WorkspaceSidebarProps) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 border-b border-zinc-100 pb-6">
        <WorkspaceBrand onNavigate={onNavigate} />
      </div>

      <WorkspaceNavigation onNavigate={onNavigate} />
    </div>
  );
}

export default function WorkspaceShell() {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 border-r border-zinc-200/80 bg-card md:flex md:flex-col">
        <WorkspaceSidebar />
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
          <Flex gap="sm">
            <Sheet
              open={mobileNavigationOpen}
              onOpenChange={setMobileNavigationOpen}
            >
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Open navigation"
                >
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              {/* No floating close button: it lands on top of the version chip
                  in the brand row, and the drawer already closes on a tap
                  outside, on Escape, and on every link inside it. */}
              <SheetContent
                side="left"
                showCloseButton={false}
                className="w-72 max-w-[85vw] p-0"
              >
                <SheetHeader className="sr-only">
                  <SheetTitle>Navigation</SheetTitle>
                  <SheetDescription>
                    Move between Hub William pages.
                  </SheetDescription>
                </SheetHeader>

                <WorkspaceSidebar
                  onNavigate={() => setMobileNavigationOpen(false)}
                />
              </SheetContent>
            </Sheet>

            <Link
              to="/"
              className="flex items-center gap-1.5 rounded-md text-xs font-bold tracking-wider uppercase transition-colors hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <span className="grid size-5 place-items-center rounded bg-zinc-900 font-mono text-[10px] text-white">
                W
              </span>
              Hub-William
            </Link>
          </Flex>

          <nav
            aria-label="Workspace sections"
            className="flex items-center gap-1 rounded-lg bg-zinc-100 p-0.5 text-[11px] font-medium"
          >
            {navigationItems.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
                className={({ isActive }) =>
                  mobileTabVariants({ active: isActive })
                }
              >
                {item.shortLabel}
              </NavLink>
            ))}
          </nav>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
