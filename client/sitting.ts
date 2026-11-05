import { SITTING_KEY } from "../mount";

/**
 * **Which table this tab is sitting at — so a reload sits back down.**
 *
 * A guest's copy of the story is module state (`guest-session.ts`), on purpose: it must never
 * reach storage. So a guest who reloaded came back to "Loading..." for ever, and the seat they
 * had not left was swept from the table after `RELOAD_GRACE_MS` — `peer_left`, their claimed
 * character let go. The seat token was remembered (`seat-store.ts`) and nothing read it on the
 * way back in: only the join screen did, when somebody typed the code again.
 *
 * What was missing is not the token but *which* table: a device can hold tokens for several,
 * and only this tab knows which one it was at. So it is `sessionStorage` — a tab's own, kept
 * across a reload and not shared with the next tab opened — beside the tokens rather than in
 * the device store, where a phone and a desktop would argue about one chair.
 *
 * The host's half is not here. A host who reloads is re-seated as host with no story bound
 * (`.agents/history/SWEEP-2026-09-22.md` §2.2), which is its own decision.
 *
 * Every access is guarded: a private window or a blocked origin throws, and a tab that cannot
 * remember is a tab that asks for the code again, which is what it did before.
 */

const KEY = SITTING_KEY;

export type Sitting = { code: string; host: string | null };

function store(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The table this tab was sitting at as a guest, or `null`. */
export function sittingAt(): Sitting | null {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Sitting>;
    return typeof parsed.code === "string" && parsed.code
      ? { code: parsed.code, host: typeof parsed.host === "string" && parsed.host ? parsed.host : null }
      : null;
  } catch {
    return null;
  }
}

export function sitDown(sitting: Sitting): void {
  try {
    store()?.setItem(KEY, JSON.stringify(sitting));
  } catch {
    // Unremembered: a reload asks for the code, as it always did.
  }
}

export function standUp(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // Nothing held, nothing to forget.
  }
}
