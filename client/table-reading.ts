import type { PublishedReveal } from "@dahlia/plugin-api";

/**
 * **The table's reading, as this tab last knew it** — ROUND-2026-11-03 §2.
 *
 * A table's reading belongs to the table, not to the host's screen. One seat walks it (the
 * `reader` the host names, `tableReaderOf` in `roomStore`), whatever chat the host's own screen is
 * on, and every other seat draws what that seat published. On the host this is the reader's latest
 * reveal: its own while it reads, or the one the guest reading it sent up. On a guest it is the last
 * reveal the host relayed. One value per tab, so a seat that takes the reading over (the host back
 * on the story, a guest named when the host walked away) stands where the table was, and the
 * table's gates are read from it whoever is reading.
 *
 * It replaced a reveal that only existed while the host had the story on screen: with the host on
 * another chat, guests walked their own reveals at their own pace, and a `released` list and a tally
 * for a guest ahead of the host existed only to reconcile those walks.
 *
 * Module state with listeners rather than a store: nothing renders from it, and the readers (the
 * gate watcher, the relay, the transcript taking the reading over) each ask at the moment they act.
 */
let latest: { chatId: string; reveal: PublishedReveal | null } | null = null;
const listeners = new Set<() => void>();

/** The table's reading of `chatId`, or null when this tab has been told none yet. */
export function tableReadingOf(chatId: string | null | undefined): PublishedReveal | null {
  return chatId && latest?.chatId === chatId ? latest.reveal : null;
}

/**
 * **`chatId` is a table's chat whose reading this tab knows** — so the reader is the table's, not
 * this tab's own walk (`readerBehindOn`), even before any seat has published a place.
 */
export function readsAtTable(chatId: string): boolean {
  return latest?.chatId === chatId;
}

/** The table's reading moved. Unchanged is not news: the relay re-sends the same reveal often. */
export function noteTableReading(chatId: string, reveal: PublishedReveal | null): void {
  if (latest?.chatId === chatId && JSON.stringify(latest.reveal) === JSON.stringify(reveal)) return;
  latest = { chatId, reveal };
  for (const listener of [...listeners]) listener();
}

/** The session ended: there is no table's reading to stand at any more. */
export function forgetTableReading(): void {
  latest = null;
}

export function onTableReading(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
