"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { NetworkBadge } from "@/components/network/network-badge";
import { WalletButton } from "@/components/wallet/wallet-button";
import { DemoControls } from "./demo-controls";
import { Logo } from "./logo";
import { RoleBadge } from "./role-badge";
import { SideNav } from "./side-nav";

/**
 * The frame of every app page. Desktop (lg and up): a sidebar with the
 * logo, navigation and demo controls, and a top bar with the network badges
 * and wallet. Phone and tablet: a top bar with a menu button that opens the
 * same navigation below it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const close = () => setMenuOpen(false);

  return (
    <div className="flex min-h-full flex-1">
      <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col gap-10 overflow-y-auto px-4 py-6 lg:flex">
        <Link href="/dashboard" className="self-start rounded-control px-3">
          <Logo />
        </Link>
        <SideNav />
        <div className="mt-auto">
          <DemoControls />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-canvas lg:border-b-0">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-12">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              className="-ml-2 rounded-control p-2 text-ink hover:bg-surface lg:hidden"
            >
              {menuOpen ? (
                <X aria-hidden className="size-6" />
              ) : (
                <Menu aria-hidden className="size-6" />
              )}
            </button>
            <Link href="/dashboard" className="rounded-control lg:hidden">
              <Logo hideNameOnPhone />
            </Link>
            <div className="ml-auto flex items-center gap-3">
              <span className="max-md:hidden">
                <RoleBadge />
              </span>
              <span className="max-sm:hidden">
                <NetworkBadge />
              </span>
              <WalletButton />
            </div>
          </div>

          {menuOpen && (
            <div
              id={menuId}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
              }}
              className="flex max-h-[calc(100dvh-4rem)] flex-col gap-6 overflow-y-auto border-t border-line px-4 pt-4 pb-6 sm:px-6 lg:hidden"
            >
              <span className="flex flex-wrap gap-2 md:hidden">
                <RoleBadge />
                <span className="sm:hidden">
                  <NetworkBadge />
                </span>
              </span>
              <SideNav onNavigate={close} />
              <DemoControls />
            </div>
          )}
        </header>

        <main className="w-full max-w-content flex-1 px-4 py-8 sm:px-6 lg:px-12 lg:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
