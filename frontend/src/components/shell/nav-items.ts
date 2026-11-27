import {
  Activity,
  ArrowLeftRight,
  Hourglass,
  LayoutDashboard,
  Plus,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };
export type NavGroup = { label: string; items: NavItem[] };

/** The app's navigation, in sidebar order. */
export const NAV: NavGroup[] = [
  {
    label: "Protocol",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
      {
        href: "/withdraw",
        label: "Deposit and withdraw",
        icon: ArrowLeftRight,
      },
      { href: "/holds", label: "Held withdrawals", icon: Hourglass },
      { href: "/rules", label: "Pauses and rules", icon: SlidersHorizontal },
      { href: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    label: "Setup",
    items: [{ href: "/register", label: "Register a protocol", icon: Plus }],
  },
];
