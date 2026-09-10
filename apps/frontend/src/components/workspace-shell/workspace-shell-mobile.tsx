import { useState } from "react";
import { LogIn, Menu } from "lucide-react";
import { Link } from "react-router";

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

import WorkspaceShellSidebar from "./workspace-shell-sidebar";
import { useWorkspaceSession } from "./workspace-shell-session-context";

/**
 * The header below `md`, and the drawer it opens.
 *
 * Whether the drawer is open lives here rather than in the shell: nothing
 * outside this header reads it, and lifting it would make every route render
 * pass through a state change that only a phone can cause.
 */
export default function WorkspaceShellMobile() {
  const session = useWorkspaceSession();

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
          className="flex items-center gap-1.5 rounded-md text-xs font-bold tracking-wider uppercase transition-colors hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <Center className="size-5 rounded bg-zinc-900 font-mono text-[10px] text-white">
            W
          </Center>
          Hub-William
        </Link>
      </Flex>

      <Button
        type="button"
        variant="outline"
        className="w-24"
        disabled={session.status === "loading"}
        onClick={session.openAuth}
      >
        <LogIn aria-hidden="true" data-icon="inline-start" />
        {session.status === "loading" ? "Checking session…" : "Login"}
      </Button>
    </header>
  );
}
