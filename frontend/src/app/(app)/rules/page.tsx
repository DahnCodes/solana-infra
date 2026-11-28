import type { Metadata } from "next";
import { RulesPanel } from "./rules-panel";

export const metadata: Metadata = { title: "Pauses and rules · Breakglass" };

export default function RulesPage() {
  return <RulesPanel />;
}
