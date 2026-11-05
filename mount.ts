/**
 * **Multiplayer's names and numbers**, read by both halves: its id, its pages, its mounts, and what
 * a guest may send. Import-free, so either half (and the build) reads it alone.
 *
 * The id stays `multiplayer-tunnel` (D2, changed): it is stored, as the key of the plugin's record
 * and the name of its folder, on the owner's libraries, and the app's update recognises the record
 * by it (`.agents/PLUGIN-PLATFORM.md` §9). The card says "Multiplayer". It is also `plugin.json`'s
 * `id`, which the build checks against this.
 */
export const MULTIPLAYER_PLUGIN_ID = "multiplayer-tunnel";

/** The table a guest's tab is sitting at, kept for its reload (`./client/sitting.ts`). */
export const SITTING_KEY = "roleplay:sitting";

/**
 * **The page a guest lands on** — the join link, and the landing the public door sends a guest to
 * (`pages`, declared `landing` in `plugin.json`).
 */
export const JOIN_PAGE = "join";

/**
 * The relay's mount, declared public: `POST room` mints a room (the reader's own devices only —
 * minting is hosting), `room/<code>/{join,poll,send,leave,kick}` is the relay, which guests reach at
 * the app's public address for plugins, `/api/plugins/<id>/public/room/<code>/…`.
 */
export const ROOM_MOUNT = "room";
/** What the lobby reads of the tunnel, and of the invite address: the reader's own devices only. */
export const TUNNEL_MOUNT = "tunnel";
export const PUBLIC_URL_MOUNT = "public-url";

/**
 * The most a guest may say in one intent.
 *
 * The host's intents carry the whole chat — a snapshot with every picture in it — and keep the
 * app's own request ceiling (their seat says `library`). A guest's are a line, a claim, a press: the
 * largest is a line with every attachment it may carry, and anything bigger is not one of those.
 */
export const MAX_GUEST_INTENT_BYTES = 8 * 1024 * 1024;

/** The JSON envelope around an intent, beyond what it says. */
const ENVELOPE_BYTES = 64 * 1024;

/** What a guest's seat may send in one request (`seatGrants`). */
export const PUBLIC_BODY_BYTES = MAX_GUEST_INTENT_BYTES + ENVELOPE_BYTES;

/**
 * The most a host's intent is held to here, and the most a room keeps unread: the app's own write
 * ceiling (64 MiB), which the app already holds the host's seat to before the plugin hears it.
 */
export const HOST_INTENT_BYTES = 64 * 1024 * 1024;
