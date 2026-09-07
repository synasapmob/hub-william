import { useState } from "react";
import { Menu } from "lucide-react";
import { Link, NavLink } from "react-router";
import { tv } from "tailwind-variants";

import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { navigationItems } from "./workspace-shell-navigation-items";
import WorkspaceShellSidebar from "./workspace-shell-sidebar";

/** The mobile header's two-up switcher. Its own table: no sidebar link shares this state. */
const mobileTabVariants = tv({
  base: "rounded-md px-2.5 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "bg-background font-semibold text-foreground shadow-xs",
      false: "text-muted-foreground",
    },
    // `pointer-events-none` is safe here in a way it would not be on a link:
    // this renders as a span, so there is nothing to focus and nothing Enter
    // can follow — the attribute only has to stop the pointer.
    disabled: {
      true: "pointer-events-none cursor-default text-muted-foreground/50",
    },
  },
});

/**
 * The header below `md`, and the drawer it opens.
 *
 * Whether the drawer is open lives here rather than in the shell: nothing
 * outside this header reads it, and lifting it would make every route render
 * pass through a state change that only a phone can cause.
 */
export default function WorkspaceShellMobile() {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
      <Flex className="items-center gap-2">
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

            <WorkspaceShellSidebar
              onNavigate={() => setMobileNavigationOpen(false)}
            />
          </SheetContent>
        </Sheet>

        <Link
          to="/"
          className="flex items-center gap-1.5 rounded-md text-xs font-bold tracking-wider uppercase transition-colors hover:text-indigo-400 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <Center className="size-5 rounded bg-primary font-mono text-[10px] text-primary-foreground">
            W
          </Center>
          Hub-William
        </Link>
      </Flex>

      <nav
        aria-label="Workspace sections"
        className="flex items-center gap-1 rounded-lg bg-muted p-0.5 text-[11px] font-medium"
      >
        {navigationItems.map((item) =>
          // A span, not a dimmed NavLink: a link that only looks disabled is
          // still focusable and still followed by Enter.
          item.isDisabled ? (
            <span
              key={item.href}
              aria-disabled="true"
              className={mobileTabVariants({ disabled: true })}
            >
              {item.label}
            </span>
          ) : (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                mobileTabVariants({ active: isActive })
              }
            >
              {item.label}
            </NavLink>
          ),
        )}
      </nav>
    </header>
  );
}
