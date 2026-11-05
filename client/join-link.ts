import { app } from "@dahlia/plugin-api";
import { JOIN_PAGE, MULTIPLAYER_PLUGIN_ID, PUBLIC_URL_MOUNT, ROOM_MOUNT, TUNNEL_MOUNT } from "../mount";

/**
 * **Multiplayer's addresses**, as the app serves them for a plugin: its join page, and its mounts —
 * the relay at the public address (a guest's only way in, and the host's tab uses it too, so both
 * hold the same seat by the same token), minting and the tunnel's status on the reader's own door.
 */

/** The join page's address with a room's code: what an invite link is, after the server's address. */
export function joinPagePath(code: string): string {
  return app.plugins.pagePath(MULTIPLAYER_PLUGIN_ID, JOIN_PAGE, { code });
}

/** One of the relay's routes for a table: `…/public/room/<code>/<verb>`. */
export function relayPath(code: string, verb: string): string {
  return `${app.plugins.mountPath(MULTIPLAYER_PLUGIN_ID, ROOM_MOUNT, { public: true })}/${encodeURIComponent(code)}/${verb}`;
}

/** Where a room is minted: the reader's own door. */
export function mintPath(): string {
  return app.plugins.mountPath(MULTIPLAYER_PLUGIN_ID, ROOM_MOUNT);
}

export const tunnelPath = (): string => app.plugins.mountPath(MULTIPLAYER_PLUGIN_ID, TUNNEL_MOUNT);
export const publicUrlPath = (): string => app.plugins.mountPath(MULTIPLAYER_PLUGIN_ID, PUBLIC_URL_MOUNT);
