import type { ComponentType } from "react";
import {
  ChartNoAxesCombined,
  ClipboardList,
  History,
  Package,
  Users,
} from "lucide-react";

import type { Permission } from "@/services/sales/sales-types";

export interface NavigationItem {
  href: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  /** The page opens, and its link shows, only for a role that has this. */
  permission: Permission;
}

/**
 * The sections, in one place: the desktop sidebar and the mobile drawer list the
 * same links, and `PermissionGate` and the `/` redirect read the same list, so
 * `/` opens the first page a role may use.
 */
export const storeNavigationItems: NavigationItem[] = [
  {
    href: "/pos",
    icon: Package,
    label: "Inventory",
    permission: "stock",
  },
  {
    href: "/orders",
    icon: ClipboardList,
    label: "Orders",
    permission: "orders",
  },
  {
    href: "/history",
    icon: History,
    label: "Sales history",
    permission: "history",
  },
];

export const managementNavigationItems: NavigationItem[] = [
  {
    href: "/revenue",
    icon: ChartNoAxesCombined,
    label: "Revenue",
    permission: "revenue",
  },
  { href: "/staff", icon: Users, label: "Staff", permission: "staff" },
];

export const navigationItems = [
  ...storeNavigationItems,
  ...managementNavigationItems,
];
