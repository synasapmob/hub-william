import { useState } from "react";
import { Menu } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import DashboardShellSidebar from "./dashboard-shell-sidebar";

/**
 * The header below `md`, and the drawer it opens. Whether the drawer is open
 * lives here: nothing outside this header reads it.
 */
export default function DashboardShellMobile() {
  const [navigationOpen, setNavigationOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex items-center border-b border-border bg-card px-4 py-3 md:hidden">
      <Flex className="items-center gap-2">
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Mở menu">
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>

          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-72 max-w-[85vw] p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Menu</SheetTitle>

              <SheetDescription>
                Chuyển giữa các trang của dashboard.
              </SheetDescription>
            </SheetHeader>

            <DashboardShellSidebar
              onNavigate={() => setNavigationOpen(false)}
            />
          </SheetContent>
        </Sheet>

        <Link
          to="/"
          className="flex items-center gap-1.5 rounded-md text-xs font-bold tracking-wider uppercase transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <Center className="size-5 rounded bg-zinc-900 font-mono text-[10px] text-white">
            W
          </Center>
          Hub-William
        </Link>
      </Flex>
    </header>
  );
}
