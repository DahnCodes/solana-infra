import { BorshEventCoder, Idl, utils } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  TransactionSignature,
  VersionedTransactionResponse,
} from "@solana/web3.js";

// Breakglass emits every event with `emit_cpi!`, not `emit!`. The event is the
// data of a self-CPI inner instruction, NOT a "Program data:" log line, so
// `program.addEventListener` will never see it. Decode inner instructions
// instead, as below. (emit_cpi is used because logs can be truncated and
// dropped by RPCs; inner instructions cannot.)

/** Anchor's EVENT_IX_TAG (0x1d9acb512ea545e4) as little-endian bytes. */
const EVENT_IX_TAG_LE = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
  signature?: string;
  slot?: number;
}

/** Decode all Breakglass CPI events from a fetched transaction. */
export function decodeCpiEvents(
  idl: Idl,
  breakglassProgramId: PublicKey,
  tx: VersionedTransactionResponse,
): DecodedEvent[] {
  const coder = new BorshEventCoder(idl);
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const out: DecodedEvent[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(breakglassProgramId)) continue;
      const raw = Buffer.from(utils.bytes.bs58.decode(ix.data));
      if (raw.length < 16 || !raw.subarray(0, 8).equals(EVENT_IX_TAG_LE)) continue;
      const ev = coder.decode(raw.subarray(8).toString("base64"));
      if (ev) {
        out.push({
          name: ev.name,
          data: ev.data as Record<string, unknown>,
          signature: tx.transaction.signatures[0],
          slot: tx.slot,
        });
      }
    }
  }
  return out;
}

/** Fetch a transaction by signature and decode its Breakglass events. */
export async function fetchEvents(
  connection: Connection,
  idl: Idl,
  breakglassProgramId: PublicKey,
  signature: TransactionSignature,
): Promise<DecodedEvent[]> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx ? decodeCpiEvents(idl, breakglassProgramId, tx) : [];
}

/**
 * Live feed: watch Breakglass transactions via logsSubscribe, then fetch and
 * decode each one. Returns an unsubscribe function.
 * For a production dashboard prefer the monitor's API (docs/FRONTEND.md),
 * which dedupes across RPCs and survives reconnects.
 */
export function onBreakglassEvents(
  connection: Connection,
  idl: Idl,
  breakglassProgramId: PublicKey,
  handler: (events: DecodedEvent[]) => void,
): () => Promise<void> {
  const id = connection.onLogs(
    breakglassProgramId,
    async (logs) => {
      if (logs.err) return;
      const events = await fetchEvents(connection, idl, breakglassProgramId, logs.signature);
      if (events.length) handler(events);
    },
    "confirmed",
  );
  return () => connection.removeOnLogsListener(id);
}
