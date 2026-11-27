import type { Metadata } from "next";
import { Montserrat, Schibsted_Grotesk } from "next/font/google";
import { SolanaProvider } from "@/components/wallet/solana-provider";
import "./globals.css";

// Faces from DESIGN.md. Both are variable fonts, so every weight is available.
const schibsted = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Breakglass",
  description:
    "Emergency circuit breaker and outflow gate for Solana protocols.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${schibsted.variable} ${montserrat.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <SolanaProvider>{children}</SolanaProvider>
      </body>
    </html>
  );
}
