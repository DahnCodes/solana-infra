import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/toast";

// Every app page sits in the shell (sidebar, top bar, wallet) and can show
// toasts. The landing page and /components sit outside this group.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AppShell>{children}</AppShell>
    </ToastProvider>
  );
}
