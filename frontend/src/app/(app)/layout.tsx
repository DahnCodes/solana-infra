import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/toast";
import { TxProvider } from "@/components/tx/tx-provider";

// Every app page sits in the shell (sidebar, top bar, wallet), can show
// toasts, and sends its writes through TxProvider (confirm first, then the
// transaction's outcome). The landing page and /components sit outside.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TxProvider>
        <AppShell>{children}</AppShell>
      </TxProvider>
    </ToastProvider>
  );
}
