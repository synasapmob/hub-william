import type { ComponentType } from "react";
import {
  Bot,
  ChartNoAxesCombined,
  FlaskConical,
  House,
  LayoutDashboard,
  Users,
  Wrench,
} from "lucide-react";

export interface NavigationItem {
  href: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
}

/**
 * The workspace's sections, in one place.
 *
 * The desktop sidebar and the mobile navigation drawer list the same sections,
 * so both consume this list to keep every page reachable on either layout.
 *
 * It is a module of its own rather than an export from the sidebar because
 * `react/only-export-components` is right about the cost: a component file that
 * also exports a value loses fast refresh for everything in it.
 */
export const navigationItems: NavigationItem[] = [
  {
    href: "/",
    icon: House,
    label: "Home",
  },
  {
    href: "/tools",
    icon: Wrench,
    label: "Tools",
  },
  {
    href: "/agents",
    icon: Bot,
    label: "Agents",
  },
  {
    href: "/playground",
    icon: FlaskConical,
    label: "Playground",
  },
];

export const organizationNavigationItems: NavigationItem[] = [
  { href: "/organization", icon: LayoutDashboard, label: "Overview" },
  { href: "/organization/agents", icon: Bot, label: "Agents" },
  { href: "/organization/members", icon: Users, label: "Members" },
  { href: "/organization/usage", icon: ChartNoAxesCombined, label: "Usage" },
];
