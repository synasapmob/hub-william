import type { ComponentType } from "react";
import { Activity, Bot, Layers, Wrench } from "lucide-react";

export interface NavigationItem {
  href: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  /**
   * The section exists but is not ready to be read.
   *
   * It stays listed rather than being hidden, because a reader who saw it
   * yesterday should not have to wonder whether they imagined it. It is
   * rendered as text rather than as a dimmed link: `pointer-events-none` stops
   * a mouse but leaves a control in the tab order, which is how a "disabled"
   * link still gets followed by a keyboard.
   */
  isDisabled?: boolean;
}

/**
 * The workspace's sections, in one place.
 *
 * The sidebar nav and the mobile header's two-up switcher list the same
 * sections, so two arrays would let a page exist on one and not the other with
 * nothing failing — it would simply be missing on a phone.
 *
 * It is a module of its own rather than an export from the sidebar because
 * `react/only-export-components` is right about the cost: a component file that
 * also exports a value loses fast refresh for everything in it.
 */
export const navigationItems: NavigationItem[] = [
  {
    href: "/library",
    icon: Layers,
    label: "Libraries",
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
    href: "/activities",
    icon: Activity,
    label: "Activities",
    isDisabled: true,
  },
];
