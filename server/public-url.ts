/**
 * The address a friend can reach this table at.
 *
 * The lobby used to build its invite link out of `window.location.origin`, which is where the
 * *host's own browser* happens to be pointed — so a host on `localhost:3939` copied a link to
 * their friend's computer, and it was confidently wrong with nothing to flag it. That is §13.2,
 * which has now shipped three times: a display that describes what the app is doing must be
 * **told**, never work it out.
 *
 * So it is told, from one of three places, in order:
 *
 * 1. the plugin's "Permanent public address" setting — a real domain, once there is one. Set once,
 *    always right, and the day it exists the tunnel is not needed. (It was `PUBLIC_BASE_URL` in the
 *    server's environment; a plugin's server half is handed no environment, and a setting is a
 *    control the reader can see.)
 * 2. what the plugin's cloudflared printed, set in-process by `plugins/multiplayer/server/tunnel.ts` — the only
 *    writer there is (the `POST` that let anything else announce one is gone, round 2026-10-06B).
 * 3. nothing, in which case the lobby says there is no public address rather than inventing one.
 *
 * Nothing here names a provider. A quick tunnel mints a new hostname every run, so it has to be
 * carried at runtime; a domain does not, so it is configuration. Both arrive here as a string.
 *
 * Kept in memory: a tunnel that is no longer running has no address, so a restart *should* forget it.
 */

/** Trim to an origin, or `""` — the same forgiveness the app gives a person typing an address. */
function asOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return "";
  }
}

const held = { configured: "", tunnel: "" };

/** The setting, as the card saved it: read again at every start and every change of settings. */
export function setConfiguredAddress(raw: unknown): void {
  held.configured = asOrigin(typeof raw === "string" ? raw : "");
}

export function publicBaseUrl(): string {
  return held.configured || held.tunnel;
}

/** The tunnel's address, or "" when it closed. */
export function setPublicBaseUrl(raw: string): string {
  held.tunnel = asOrigin(raw);
  return held.tunnel;
}

export function publicUrlIsPermanent(): boolean {
  return Boolean(held.configured);
}
