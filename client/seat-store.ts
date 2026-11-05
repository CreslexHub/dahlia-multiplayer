import { app } from "@dahlia/plugin-api";

const { getSeat, setSeat } = app.identity;
/**
 * The seat token this device holds for a table, kept across a reload.
 *
 * A participant id is what the story builds a cast member out of (`playerCharacterId`), so
 * losing it loses your character: you come back as a stranger sitting beside your own
 * abandoned card, and the roster shows both. That is what happened when identity was minted
 * fresh on every connection — and it did not happen before, because identity used to be an
 * *account*, which survived a refresh by being written down somewhere.
 *
 * There is no account any more, so the durable thing is this: the secret the room gave us,
 * against the table it was given for. The server treats a token it still knows as the seat it
 * already is (`joinRoom`), so a reload asks the same question and gets the same answer.
 *
 * Device-local and deliberately not a sync key — the same rule as the server address in
 * `lib/net/api.ts`. A seat at a table is a property of the tab that is sitting in it, and a
 * phone adopting the desktop's seat would be two devices fighting over one chair.
 *
 * Kept in `lib/device/settings.ts` with the rest of what this device knows about itself, which
 * is IndexedDB. A seat token is a credential — a small one, dead when the room is — and it was
 * sitting in `localStorage`.
 */


/**
 * One key per table, and a table is a *host* plus a code.
 *
 * The host is part of it because a code is only six characters and two people you play with
 * could hold `ABCDEF` at the same time — on their own servers, meaning nothing to each other.
 * An empty host is "the server that sent this page", which is what a guest at a tunnel and a
 * host on their own machine both are.
 */
function keyFor(host: string | null | undefined, code: string): string {
  return `${ourOwnServer(host) ? "" : host}|${code.toUpperCase()}`;
}

/**
 * **An address that *is* this page's origin is the empty host by another name.**
 *
 * The join screen takes a whole invite link as well as six characters, and reads the host out
 * of the link — so the same guest, on the same tunnel, keyed their seat under
 * `https://tunnel|ABC234` when they pasted the link and under `|ABC234` when they typed the
 * code. Two keys for one chair: the second way in found nothing, minted a fresh seat, and
 * left their character standing in the story without them.
 *
 * A bundled app's origin is its own scheme and is never a host anybody types, so this changes
 * nothing there — which is the case the two-keys spelling was right about.
 */
export function ourOwnServer(host: string | null | undefined): boolean {
  if (!host) return true;
  const here = (globalThis as { location?: { origin?: string } }).location?.origin;
  return !!here && host === here;
}

/** The token we already hold for this table, or `""` — which asks for a new seat. */
export function rememberedSeat(host: string | null | undefined, code: string): string {
  return getSeat(keyFor(host, code));
}

/** Keep the seat we were given. An empty token forgets it — leaving is not a reload. */
export function rememberSeat(host: string | null | undefined, code: string, token: string): void {
  setSeat(keyFor(host, code), token);
}
