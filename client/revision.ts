/**
 * **"Am I current?" — a question the guest could not ask.**
 *
 * Nothing a guest ever received carried a version of any kind: no version on the story, none
 * on the session, no sequence on an append. So a guest holding a stale copy and a guest
 * holding the truth were *indistinguishable from inside the guest*, and the only thing that
 * ever fixed a divergence was an unrelated change happening to force a re-send
 * (`.agents/SYNC.md` §2).
 *
 * A revision is the producer saying which version it is on. That is the rule this repo keeps
 * re-learning — a display that describes what the app is doing must be **told**, never work it
 * out — and the wire is the same law: the host knows what generation of the story it is
 * broadcasting, so it says so, and the guest compares two numbers instead of inferring its own
 * currency from the shape of what arrived.
 *
 * ── Why it is a pair and not a counter ───────────────────────────────────────────────────
 *
 * `n` alone is a number that **restarts**. A host reload mints a fresh module state while the
 * room lives on in the server's registry and the guests live on with it — so a guest holding
 * `n: 57` would reject `n: 1` from a host that is now the authority, and be deaf for the rest
 * of the evening with everything apparently working. The counter that used to decide the
 * continue gate had exactly this shape (`gateSeq`, module scope, reset by a reload) and it
 * worked by luck.
 *
 * `epoch` is minted once per authority — per host connection, per hosted chat — so "a different
 * epoch" means "a new authority, adopt whatever it says" and `n` only ever has to answer
 * "newer than what I hold, within the same authority".
 */

export type Revision = {
  /** Who is speaking. A new one means a new authority, whatever its `n` says. */
  epoch: string;
  /** How many times that authority has spoken. Rises by one per broadcast. */
  n: number;
};

/** A fresh authority, at its first word. */
export function firstRevision(): Revision {
  return { epoch: crypto.randomUUID(), n: 0 };
}

/** The same authority, one step on. */
export function nextRevision(rev: Revision): Revision {
  return { epoch: rev.epoch, n: rev.n + 1 };
}

/**
 * Is `incoming` worth applying over `held`?
 *
 * Three answers and they are all "yes" except one: hold nothing and anything is news; a
 * different epoch is a new authority and its word replaces whatever this tab was holding; the
 * same authority is only worth hearing when it has moved on. **Not `>=`** — re-applying the
 * same revision would wipe a guest's own optimistic state for no new information.
 */
export function isNewer(incoming: Revision, held: Revision | null): boolean {
  if (!held) return true;
  if (incoming.epoch !== held.epoch) return true;
  return incoming.n > held.n;
}

/**
 * Is `incoming` *older* than what this tab holds, within the same authority?
 *
 * **Not `!isNewer`, and the difference is the whole of `.agents/SYNC.md` §11.1.** `isNewer` is
 * the test an **event** wants — an append applied twice is a line of the story written twice, so
 * the same revision must be refused. A **whole value** — a snapshot, a table state — is
 * idempotent: applying the generation you already hold costs nothing and changes nothing, and
 * *refusing* it is how a guest came to throw away the very answer it had asked for.
 *
 * So a whole value is only ever refused for going backwards. A different epoch is a new
 * authority and is always adopted, whatever its count says.
 */
export function isStale(incoming: Revision, held: Revision | null): boolean {
  if (!held) return false;
  if (incoming.epoch !== held.epoch) return false;
  return incoming.n < held.n;
}

/**
 * Does `incoming` follow directly from what this tab holds?
 *
 * The question an *append* has to answer, and the one nothing could ask before: a message that
 * claims to follow revision 8 arriving at a tab holding 6 means two lines of the story went
 * missing on the wire. Before this, a lost append left a hole that neither side could see —
 * and the guest's transcript was simply, quietly, wrong.
 */
export function follows(base: Revision, held: Revision | null): boolean {
  return held !== null && base.epoch === held.epoch && base.n === held.n;
}

/** Shape check for a revision off the wire — a malformed one must read as "no idea". */
export function readRevision(raw: unknown): Revision | null {
  if (!raw || typeof raw !== "object") return null;
  const { epoch, n } = raw as Partial<Revision>;
  if (typeof epoch !== "string" || !epoch) return null;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return { epoch, n };
}
