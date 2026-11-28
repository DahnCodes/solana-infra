import type { Metadata } from "next";
import { WaitingRoom } from "./waiting-room";

export const metadata: Metadata = { title: "Held withdrawals · Breakglass" };

export default function HoldsPage() {
  return <WaitingRoom />;
}
