import { Link, NavLink, type NavLinkRenderProps } from "react-router";
import { tv } from "tailwind-variants";

import Center from "@/components/ui/center";
import assetPath from "@/utils/utils.asset-path";

import WorkspaceShellAccount from "./workspace-shell-account";
import { navigationItems } from "./workspace-shell-navigation-items";

const navigationLinkVariants = tv({
  base: "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "bg-zinc-900 text-white shadow-xs",
      false: "text-muted-foreground hover:bg-zinc-100/80 hover:text-foreground",
    },
    // `pointer-events-none` is safe here in a way it would not be on a link:
    // this renders as a span, so there is nothing to focus and nothing Enter
    // can follow — the attribute only has to stop the pointer.
    disabled: {
      true: "pointer-events-none cursor-default text-muted-foreground/50",
    },
  },
});

const navigationIconVariants = tv({
  base: "size-4",
  variants: {
    active: { true: "text-white", false: "text-zinc-500" },
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
      className="rounded-lg text-left font-semibold tracking-wider uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <Center className="justify-between">
        <Center>
          <Center className="size-10">
            <img
              src={assetPath("logo.png")}
              alt=""
              className="pointer-events-none size-16 object-cover"
            />
          </Center>

          <p className="text-xs">Hub-William</p>
        </Center>

        <div className="rounded border border-zinc-200/80 bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">
          v1.4
        </div>
      </Center>
    </Link>
  );
}

interface WorkspaceNavigationProps {
  onNavigate?: () => void;
}

function WorkspaceNavigation({ onNavigate }: WorkspaceNavigationProps) {
  return (
    <nav aria-label="Workspace" className="flex-1">
      <div className="space-y-1">
        <p className="px-2 pb-2 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          Workspace
        </p>

        {navigationItems.map((item) => {
          const Icon = item.icon;

          // A span, not a dimmed NavLink: a link that only looks disabled is
          // still focusable and still followed by Enter.
          if (item.isDisabled) {
            return (
              <span
                key={item.href}
                aria-disabled="true"
                className={navigationLinkVariants({ disabled: true })}
              >
                <Icon aria-hidden={true} className="size-4 text-zinc-300" />
                <span>{item.label}</span>
              </span>
            );
          }

          return (
            <NavLink
              key={item.href}
              to={item.href}
              onClick={onNavigate}
              className={({ isActive }: NavLinkRenderProps) =>
                navigationLinkVariants({ active: isActive })
              }
            >
              {({ isActive }: NavLinkRenderProps) => (
                <>
                  <Icon
                    aria-hidden={true}
                    className={navigationIconVariants({ active: isActive })}
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

interface WorkspaceShellSidebarProps {
  onNavigate?: () => void;
}

/**
 * One sidebar, rendered by the persistent aside and by the mobile drawer.
 *
 * It is a module-level component rather than markup held in a variable: the two
 * parents are different elements, so a shared variable would remount the whole
 * subtree — and its focus — every time the drawer opened. Splitting the shell
 * into a desktop file and a mobile file does not change that; it is why this
 * file is a third one rather than markup either container owns.
 */
export default function WorkspaceShellSidebar({
  onNavigate,
}: WorkspaceShellSidebarProps) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 border-b border-zinc-100 pb-6">
        <WorkspaceBrand onNavigate={onNavigate} />
      </div>

      <WorkspaceNavigation onNavigate={onNavigate} />

      <WorkspaceShellAccount onNavigate={onNavigate} />
    </div>
  );
}
