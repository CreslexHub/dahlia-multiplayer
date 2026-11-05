import type { Intent } from "@dahlia/plugin-api";
/**
 * The wire vocabulary for a live room.
 *
 * One file, imported by both halves — the SSE routes that speak it and the browser that
 * listens — because the first version of every sync bug in this repo was two hand-written
 * lists that had to agree (AGENTS.md §13.1). A server event added here is a type the client
 * switch must handle before `tsc` passes, instead of a string it silently drops.
 *
 * Free of imports but types, so nothing here drags another graph along. The name a seat is drawn
 * by follows the profile's rule (`lib/auth/player-name.ts`), not one of the wire's own.
 *
 * The transport is SSE down + POST up (MULTIPLAYER.md §5). The server is a relay and a
 * presence book, nothing more: it knows who is connected to a room, and it forwards
 * `RoomIntent`s without reading them. Everything it *understands* is in `RoomServerEvent`;
 * everything it merely carries is behind `intent.kind`, which is the host's and guests'
 * business (§2.1 — the host's tab is authoritative, the server stays dumb).
 */


/** Codes avoid 0/O/1/I/L — read aloud over a call, those are coin flips. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;

/** A lobby is a handful of friends, not a server. The cap is a named number, not a hope. */
export const MAX_ROOM_PLAYERS = 8;

/**
 * One connected person, as the room tells everyone about them.
 *
 * `id` is the account owner (`lib/auth/owner.ts`) — opaque, stamped by the server from the
 * verified session, never accepted from a client. It identifies, it does not authenticate:
 * knowing someone's id lets you address them, not impersonate them, because `from` on every
 * relay is stamped server-side too.
 */
export type PlayerRef = {
  id: string;
  name: string;
  isHost: boolean;
};

/**
 * What a client asks the server to carry. Opaque to the server on purpose: the moment the
 * relay grows a branch per `kind`, domain logic has moved into `app/api/*`, which is the
 * line MULTIPLAYER.md §5 says to defend. New kinds are declared where they are *used* —
 * the host/guest stores — not here.
 *
 * **Who an intent is addressed to is part of what it is**, and the server cannot decide it
 * because it does not read `kind`. So the rule is here, for every kind wherever it is declared:
 *
 *  - **guest → host** — a request only the host acts on (a line, an edit, a verdict, a note,
 *    a claim, a press, a resync). Always addressed, through `toHost()` in `roomStore.ts` and
 *    never by a bare `wire.*` call. A broadcast put a "You only" note into every other
 *    guest's mailbox, a picture on the tunnel once per reader, and a guest's line behind the
 *    backlog of a third guest whose phone was asleep.
 *  - **host → one seat** — anything that differs per reader or answers one reader (a
 *    snapshot, which is redacted per guest; a refusal; a catch-up) names that seat.
 *  - **host → everyone** — what every reader holds alike: an append, the run in flight, the
 *    table state.
 *  - **anyone → everyone** — talk between people, which every screen draws whoever sent it:
 *    `typing` and `ooc`. The only guest sends left unaddressed, on purpose.
 */
export type RoomIntent = Intent;

/**
 * **Why a seat said goodbye** — carried on `/leave` as `?reason=`, because the two are not the
 * same event and only the tab can tell them apart.
 *
 *  - `leave` — the reader pressed Leave. They are gone, and the table should move on at once:
 *    their claim freed, a mic in their hand advanced.
 *  - `unload` — the page is going away and cannot say whether it is coming back: a reload, a
 *    closed tab, a phone putting the browser in the background. A reload re-seats as the same
 *    participant (the seat token is kept), so treating it as a leave cost the reader the
 *    character they had claimed and the mic they were holding, a second before they sat back
 *    down as themselves. The room is the party that can wait to see whether the seat polls
 *    again; this is the tab telling it that it should.
 */
export const LEAVE_REASON_PARAM = "reason";
export type LeaveReason = "leave" | "unload";

export type RoomCloseReason = "host_left" | "expired";

/**
 * Why a door turned somebody away — **every one of them**, because the reader is told which.
 *
 * `busy` is the door's 429: too many wrong codes, or too many new seats, from one address. It
 * used to fall through to "That room is full" — untrue, and the wrong advice: waiting a few
 * minutes is what helps, and a full room does not empty for that.
 *
 * `banned` was missing, and the room has always answered it: `joinRoom` refuses a kicked
 * seat's token and the address it joined from, and the route puts that word in the body. The
 * browser read the *status* instead — 403 or 409 meant "full" — so a kicked guest coming back
 * was told "That room is full", which is untrue and points them at the wrong action: wait and
 * try again, rather than ask the host. The honest sentence was already in the copy table, two
 * rows below the one they got.
 *
 * The list is here as a value as well as a type, so the browser can check what came back
 * against the same one rather than a second copy written where it is read.
 */
export const JOIN_REFUSED_REASONS = ["not_found", "full", "banned", "busy"] as const;
export type JoinRefusedReason = (typeof JOIN_REFUSED_REASONS)[number];

/** What the door said, if it said one of the three. */
export function joinRefusedReason(raw: unknown): JoinRefusedReason | null {
  return (JOIN_REFUSED_REASONS as readonly unknown[]).includes(raw) ? (raw as JoinRefusedReason) : null;
}

/**
 * Everything the server ever says down the wire (a long-poll answer's `events` — see
 * `plugins/multiplayer/server/rooms.ts` for why it is not a stream).
 *
 * Terminal events — `join_refused`, `room_closed`, `replaced` — end the poll loop for
 * good; everything else is delivered in order and acknowledged by sequence. A refused
 * join arrives as an HTTP status on the poll and is folded back into `join_refused` by
 * the connection, so the store has one vocabulary for endings.
 */
export type RoomServerEvent =
  | { type: "hello"; code: string; you: PlayerRef; roster: PlayerRef[] }
  | { type: "peer_joined"; player: PlayerRef }
  /**
   * Somebody at the table changed what they are called.
   *
   * Its own event rather than another `peer_joined` carrying the new ref, even though every
   * client upserts the roster by id and would have applied that correctly. A join is not
   * only a name: the host answers one by re-sending the session settings, the mic state, the
   * table's gate and the whole story snapshot with every portrait in it. A rename needs none
   * of that, and a client working out which kind of `peer_joined` it was holding is the
   * "recover the structure from the text you were handed" shape (CLAUDE.md). The producer
   * knows, so it says.
   */
  | { type: "peer_renamed"; id: string; name: string }
  | { type: "peer_left"; id: string }
  | { type: "join_refused"; reason: JoinRefusedReason }
  | { type: "room_closed"; reason: RoomCloseReason }
  | { type: "replaced" }
  /** The host removed this player. Enforced by the registry: their seat is gone and the
   *  room refuses their polls from then on — a client ignoring this event stays out. */
  | { type: "kicked" }
  | { type: "relay"; from: string; intent: RoomIntent };

/**
 * The events after which the server will never speak on this stream again.
 *
 * One list, because two things act on it and must agree: the connection stops its poll
 * loop (asking again after being told "you were replaced" would seat the tab right back),
 * and the store shows the person why the room ended.
 */
export const TERMINAL_EVENT_TYPES = ["join_refused", "room_closed", "replaced", "kicked"] as const;

export function isTerminalEvent(event: RoomServerEvent): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}

