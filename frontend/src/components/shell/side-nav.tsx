"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/cx";
import { NAV } from "./nav-items";

/** The grouped page links. The current page is a white pill. */
export function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-6">
      {NAV.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <h2 className="px-3 pb-1 font-label text-caption font-semibold text-ink-muted uppercase">
            {group.label}
          </h2>
          <ul className="flex flex-col gap-1">
            {group.items.map(({ href, label, icon: Icon }) => {
              const current =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={current ? "page" : undefined}
                    className={cx(
                      "flex items-center gap-3 rounded-panel px-3 py-2.5 text-title2 transition-colors",
                      current
                        ? "bg-surface font-medium text-ink"
                        : "text-ink-secondary hover:bg-surface hover:text-ink",
                    )}
                  >
                    <Icon aria-hidden className="size-5 shrink-0" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
