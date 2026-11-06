import { ChevronsUpDown, LogOut } from "lucide-react";
import { Link, NavLink, type NavLinkRenderProps } from "react-router";
import { tv } from "tailwind-variants";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ImageFallBack from "@/components/ui/image-fallback";
import { roleLabels } from "@/services/sales/sales-labels";
import { initials } from "@/utils/utils.format";

import { useDashboardSession } from "./dashboard-session-context";
import {
  managementNavigationItems,
  storeNavigationItems,
  type NavigationItem,
} from "./dashboard-shell-navigation-items";

const navigationLink = tv({
  base: "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "bg-zinc-900 text-white shadow-xs",
      false: "text-muted-foreground hover:bg-zinc-100/80 hover:text-foreground",
    },
  },
});

const navigationIcon = tv({
  base: "size-4",
  variants: { active: { true: "text-white", false: "text-zinc-500" } },
});

interface NavigateProps {
  onNavigate?: () => void;
}

function DashboardBrand({ onNavigate }: NavigateProps) {
  return (
    <Link
      to="/"
      onClick={onNavigate}
      className="rounded-lg text-left font-semibold tracking-wider uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <Flex className="items-center gap-2.5">
        <Center className="size-10 shrink-0">
          <ImageFallBack
            src="/logo.png"
            alt=""
            fallback="HW"
            className="pointer-events-none size-16 object-cover"
          />
        </Center>

        <div className="space-y-1">
          <p className="text-xs">Hub-William</p>

          <div className="w-fit rounded border border-zinc-200/80 bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] leading-none text-zinc-700">
            Dashboard
          </div>
        </div>
      </Flex>
    </Link>
  );
}

interface NavigationGroupProps extends NavigateProps {
  items: NavigationItem[];
  label: string;
}

function NavigationGroup({ items, label, onNavigate }: NavigationGroupProps) {
  const session = useDashboardSession();

  const visible = items.filter((item) => session.can(item.permission));

  if (visible.length === 0) return null;

  return (
    <nav aria-label={label}>
      <div className="space-y-1">
        <p className="px-2 pb-2 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          {label}
        </p>

        {visible.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.href}
              to={item.href}
              onClick={onNavigate}
              className={({ isActive }: NavLinkRenderProps) =>
                navigationLink({ active: isActive })
              }
            >
              {({ isActive }: NavLinkRenderProps) => (
                <>
                  <Icon
                    aria-hidden={true}
                    className={navigationIcon({ active: isActive })}
                  />

                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

function DashboardShellAccount({ onNavigate }: NavigateProps) {
  const session = useDashboardSession();

  return (
    <div className="mt-4 border-t border-zinc-100 pt-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-zinc-100/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden">
            <Avatar>
              <AvatarFallback>{initials(session.staff.name)}</AvatarFallback>
            </Avatar>

            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold">
                {session.staff.name}
              </span>

              <span className="block text-[11px] text-muted-foreground">
                {roleLabels[session.staff.role]}
              </span>
            </span>

            <ChevronsUpDown
              aria-hidden={true}
              className="size-4 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-60" side="top">
          <DropdownMenuItem
            onSelect={() => {
              onNavigate?.();
              session.signOut();
            }}
          >
            <LogOut aria-hidden={true} />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * One sidebar, rendered by the persistent aside and by the mobile drawer. It is
 * its own component rather than shared markup so opening the drawer does not
 * remount a subtree held in a variable.
 */
export default function DashboardShellSidebar({ onNavigate }: NavigateProps) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 border-b border-zinc-100 pb-6">
        <DashboardBrand onNavigate={onNavigate} />
      </div>

      <div className="flex-1 space-y-7 overflow-y-auto">
        <NavigationGroup
          items={storeNavigationItems}
          label="Shop"
          onNavigate={onNavigate}
        />

        <NavigationGroup
          items={managementNavigationItems}
          label="Management"
          onNavigate={onNavigate}
        />
      </div>

      <DashboardShellAccount onNavigate={onNavigate} />
    </div>
  );
}
