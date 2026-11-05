import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  MAX_ROOM_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type LeaveReason,
  type PlayerRef,
  type RoomCloseReason,
  type RoomIntent,
  type RoomServerEvent,
} from "../shared/protocol";
import { HOST_INTENT_BYTES, MAX_GUEST_INTENT_BYTES, PUBLIC_BODY_BYTES, ROOM_MOUNT } from "../mount";
import type { PluginSeatGrant } from "@dahlia/plugin-api/server";

/**
 * The rooms that exist right now, on this server, in memory.
 *
 * Deliberately not in SQLite: a room is live coordination between connected browsers
 * (MULTIPLAYER.md §2.2), and a restart rightly forgets it. The registry lives on
 * `globalThis` for the same reason the SQLite connection does (`lib/server/db.ts`): in
 * dev, Next re-instantiates route modules on edit, and a module-level map would strand
 * every participant in an orphaned copy of the registry.
 *
 * ── Who a participant is, and why it is not an account ───────────────────────────────────
 *
 * It used to be the `owner` off a signed session — so being at a table required having an
 * account **on the host's own server**, made through an invite-gated sign-up form. That is
 * gone (`.agents/ACCESS.md`): a guest arrives through a tunnel with a room code and nothing
 * else, and a room code is the whole credential.
 *
 * So a seat is minted here. `join` hands back two strings: a **participant id**, which is
 * public — it is broadcast in the roster, it keys claims and typing and the table gate, and
 * `playerCharacterId` builds a cast member out of it — and a **token**, which is secret and
 * proves the bearer owns that seat. The client keeps the token against the room code, so a
 * reload rejoins the *same* seat rather than arriving as a stranger who has lost their
 * character.
 *
 * Both die with the room. Nothing here is written to disk, and no participant id is ever
 * accepted as a storage owner — see `lib/auth/owner.ts`. That separation is the reason a
 * stranger at the tunnel cannot reach the library: not a rule this file enforces, but a
 * value it never produces.
 *
 * ── Why mailboxes and long-polling, not an SSE stream ────────────────────────────────────
 *
 * The first transport was SSE. It worked in every local test — Node, real Chrome, even a
 * local HTTP/2 TLS proxy — and then delivered **nothing** through the Cloudflare quick
 * tunnel: the QUIC uplink (cloudflared 2026.6.0) holds a streaming response back in its
 * entirety — 0 bytes in 20 seconds, through 80 KB of events, padding and keepalives — and
 * flushes only when the stream ends. Measured, not guessed. The host saw every guest join
 * while every guest sat on "connecting", because joins went up fine and nothing came down.
 *
 * A response that *closes* was delivered instantly in the same test. So each participant
 * has a mailbox of sequence-numbered events, and a poll parks until the mailbox has
 * something (same latency as a push when something happens), then answers **and closes**.
 * Events stay queued until the *next* poll acknowledges them by sequence — a response
 * lost in transit is re-delivered, and the client skips what it has already seen.
 *
 * The server's role is unchanged: presence and relay. Who has the mic, whether AI is on,
 * what the story says — the host's tab owns all of it (§2.1) and this file never learns.
 */

/** How long a poll may park before answering empty. Under every common proxy timeout. */
export const POLL_PARK_MS = 25_000;

/**
 * A participant with no poll parked and none arriving for this long has gone — tab
 * closed without a goodbye, network dropped. Longer than one park plus a slow re-poll.
 */
export const PRESENCE_TTL_MS = 40_000;

/** A host refresh re-polls in seconds; the grace forgives a reload without stranding guests. */
export const HOST_GRACE_MS = 15_000;

/**
 * How long a seat whose page went away is kept before the room decides it has gone.
 *
 * Shorter than the presence TTL, which is sized for a network that dropped without a word; a
 * page that said it was unloading has told the room something, and a reload sits back down in
 * seconds. Past this the seat is swept like any silent one, and the table moves on.
 */
export const RELOAD_GRACE_MS = 15_000;

/** A room nobody is seated in — created and abandoned, or everyone left — is reaped. */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;

/**
 * A mailbox past this size means its owner has not acknowledged anything for far too
 * long; rather than grow without bound the room treats them as gone.
 */
export const MAX_QUEUED_EVENTS = 1000;

/**
 * ...and the same rule measured in bytes, which is the one memory actually obeys.
 *
 * A count alone let one guest hold two seats, have one never acknowledge anything, and aim
 * intents of up to the whole request ceiling at it: a thousand of those sat in the host's
 * process — the desktop app — until it died (the sweep's probe held 900 one-megabyte intents
 * without complaint). One request ceiling's worth always fits, so a single whole-chat snapshot
 * to a slow reader never evicts them on its own.
 */
export const MAX_QUEUED_BYTES = HOST_INTENT_BYTES;


/**
 * **The most one member may have waiting in another member's mailbox.**
 *
 * Overflowing a mailbox evicts its *owner*, which is the right answer for a reader who has
 * stopped acknowledging — and was a weapon for as long as anybody else could do the filling.
 * Participant ids are public in every roster and `to` names any of them, so nine concurrent
 * full-size intents aimed at a guest threw that guest out of the room: `peer_left`, their
 * claim dropped, the mic moved on, their character left behind. Aimed at the host's id it
 * evicted the host, and the re-seat's `hello` re-sent the whole chat, portraits and all, to
 * everyone at the table — once per attack round.
 *
 * Derived rather than picked, in both units the mailbox is measured in: the ceiling divided
 * by the seats, so one member's traffic **alone cannot fill a mailbox** however hard it
 * tries. A guest's single largest intent still fits when nothing of theirs is outstanding,
 * and past that the *sender's* POST is refused and their outbox retries — backpressure, never
 * a verb one member aims at another.
 *
 * The host is exempt. Its intents are the story: a whole-chat snapshot is one of them, and a
 * reader who never acknowledges one is exactly the case the mailbox ceiling was written for.
 */
export const MAX_OUTSTANDING_BYTES_PER_MEMBER = Math.floor(MAX_QUEUED_BYTES / MAX_ROOM_PLAYERS);
export const MAX_OUTSTANDING_EVENTS_PER_MEMBER = Math.floor(MAX_QUEUED_EVENTS / MAX_ROOM_PLAYERS);

/**
 * Tokens a room keeps at once, and what happens at the cap.
 *
 * A token outlives its seat on purpose (a reload keeps your character), so without a cap the map
 * only grows: 5,000 joins minted 5,000 tokens that the room kept until it closed. A token that
 * never polls inside the presence window was never a person arriving, and is forgotten.
 *
 * **At the cap the room forgets the seat that has been away longest — it never refuses the
 * newcomer.** It used to answer `full`, and a seat that had polled once was kept for the room's
 * whole life, so anybody holding the code could join, poll and leave sixty-three times and every
 * later arrival was told the room was full with the table empty — kicking them freed nothing and
 * the host's only way out was a new room. The count is a memory bound, not a door; the door is
 * `MAX_ROOM_PLAYERS`, which counts people who are actually here.
 */
export const MAX_SEATS_PER_ROOM = MAX_ROOM_PLAYERS * 8;

/**
 * **What the registry says *about* a member is charged to that member, in time.**
 *
 * The per-member mailbox share above covers relays, and nothing covered the events the registry
 * writes itself: a rename is one `peer_renamed` to everybody per poll, and a poll from a fresh
 * `connId` is a `peer_joined` to everybody — plus, on the host's tab, a whole-chat snapshot to
 * that seat. So a guest polling with its name alternating A/B, or with a new tab id every time,
 * filled somebody else's mailbox with zero-byte events until it overflowed and **evicted the
 * reader**: measured at 1,002 polls to throw the host out, 1,001 to throw out a guest. Easiest
 * against a phone whose tab the OS has put to sleep, which is exactly the guest a table has.
 *
 * A rename is never refused — the name is applied at once, and only the *broadcast* waits, so
 * typing a name in the profile still lands on every screen with its last letter. A tab replacing
 * its seat is a reload or a second window, a handful a minute at the very most; past this many
 * in the window it is asked to come back later (`busy`, which the client retries).
 */
export const RENAME_BROADCAST_INTERVAL_MS = 1_000;
export const MAX_TAB_REPLACEMENTS = 5;
export const TAB_REPLACEMENT_WINDOW_MS = 10_000;

/** The longest `connId` a poll may carry. A tab id is a UUID; the retired map holds each for 40s. */
export const MAX_CONN_ID_LENGTH = 64;

/**
 * How many bytes of secret a seat token carries.
 *
 * 32 bytes, base64url — the same order as a session cookie's signature, because it is doing
 * the same job for a shorter time. The room code is six characters from a 31-letter alphabet
 * and is a thing people read aloud; the token is a thing only a browser ever sees, so it has
 * no reason to be short.
 */
const TOKEN_BYTES = 32;

type QueuedEvent = {
  seq: number;
  event: RoomServerEvent;
  bytes: number;
  /** Which member put it here, or absent for the room's own events — see the ceiling above. */
  from?: string;
};

export type PollResult =
  | { ok: true; seq: number; events: RoomServerEvent[] }
  | { ok: false; reason: "not_found" | "full" | "busy" };

export type RelayResult = "ok" | "not_found" | "not_member" | "too_large" | "backlogged" | "absent";

export type JoinResult =
  | { ok: true; id: string; token: string; isHost: boolean; minted: boolean }
  | { ok: false; reason: "not_found" | "full" | "banned" | "busy" };

type Waiter = {
  resolve: (result: PollResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Participant = {
  /** Public, broadcast in the roster, and what every table fact is keyed by. */
  id: string;
  name: string;
  /** Which tab of this seat is live. A poll from a new one replaces the old (§join). */
  connId: string;
  queue: QueuedEvent[];
  /** What `queue` weighs, kept beside it rather than re-measured on every relay. */
  queuedBytes: number;
  nextSeq: number;
  waiter: Waiter | null;
  lastSeen: number;
  /** When the room last told everybody this member's name — see `RENAME_BROADCAST_INTERVAL_MS`. */
  renamedAt: number;
  /** The one deferred broadcast of a name changed inside the interval, if any. */
  renameTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The last sequence any poll of this tab was answered with — so what is past it has never
   * left the room, and is what a new tab of the host's seat inherits (`Room.hostMail`).
   */
  handedThrough: number;
};

type Room = {
  code: string;
  hostParticipant: string;
  participants: Map<string, Participant>;
  /**
   * Secret → seat. The only thing that turns a request into a participant.
   *
   * Kept beside the participants rather than inside them because a token outlives a seat by
   * design: a guest whose tab slept past the presence TTL is evicted, and their next poll has
   * to be able to sit back down as *themselves* rather than as a new person with no character.
   */
  seats: Map<string, string>;
  /** Seats minted and never sat in, by when — reaped past the presence window (see the cap). */
  unseated: Map<string, number>;
  /**
   * Connection ids whose seat was taken by a newer tab. Without this a replaced tab's
   * *next* poll — it does not know yet — would seat itself again and the two tabs would
   * steal the seat from each other forever. A retired id polls once more, is told
   * `replaced`, and stops.
   */
  retired: Map<string, number>;
  /**
   * Seats the host has removed. A ban outlives the seat: a kicked client's next poll — and
   * every rejoin attempt on the same token — is answered `kicked`, so ignoring the event
   * buys nothing. Cleared only with the room; a kick is for the session.
   */
  banned: Set<string>;
  /**
   * ...and where they were, so that throwing the token away is not a way back in.
   *
   * The ban used to be per-account, and an account was a durable thing. A seat is not: a
   * kicked guest who clears their storage and rejoins with the code would arrive as somebody
   * new. The address is the only durable thing a room ever learns about a guest, so it is
   * what the ban is *also* filed under. It is imperfect — a phone changing networks changes
   * its address — and the honest alternative is asking the host to close the room, which they
   * can always do.
   */
  bannedAddresses: Set<string>;
  /** Where each seat joined from, kept for exactly as long as the ban needs it. */
  addresses: Map<string, string>;
  /** When each seat's recent tab replacements happened — see `MAX_TAB_REPLACEMENTS`. */
  replacements: Map<string, number[]>;
  emptySince: number | null;
  hostGrace: ReturnType<typeof setTimeout> | null;
  /**
   * **What the table said to the host that no tab of theirs has been handed yet.**
   *
   * The host's mailbox went with the participant: an eviction deleted it, and a new tab of the
   * host's seat (a reload) started a fresh one — so a guest's line accepted a moment before
   * either was never read by anybody, after the send had answered "ok" and the composer had
   * cleared. Only the host's, because only the host's mail is the table's words: a guest's is
   * the host's own broadcasts, which the snapshot a returning guest is sent already covers.
   * Only what was never handed out, because what a poll carried was the old tab's to apply.
   */
  hostMail: QueuedEvent[];
};

const REGISTRY = Symbol.for("roleplay.rooms");
type Holder = typeof globalThis & { [REGISTRY]?: Map<string, Room> };

function rooms(): Map<string, Room> {
  const holder = globalThis as Holder;
  if (!holder[REGISTRY]) holder[REGISTRY] = new Map();
  return holder[REGISTRY];
}

function playerRef(room: Room, p: Participant): PlayerRef {
  return { id: p.id, name: p.name, isHost: p.id === room.hostParticipant };
}

/** Everything a participant has not acknowledged yet, answered through their waiter or poll. */
function unacked(p: Participant): PollResult {
  return { ok: true, seq: p.nextSeq - 1, events: p.queue.map((q) => q.event) };
}

/** Answer with the mailbox — and record that everything in it has now left the room. */
function handOut(p: Participant): PollResult {
  p.handedThrough = p.nextSeq - 1;
  return unacked(p);
}

/** Answer a parked poll, if there is one, with the mailbox. */
function flushMail(p: Participant): void {
  if (p.waiter) flushWaiter(p, handOut(p));
}

/**
 * The host's seat leaves the participants: keep what was never handed out for their next tab.
 * Member mail only — the room's own events (a join, a rename) are re-said by the fresh `hello`.
 */
function keepHostMail(room: Room, p: Participant): void {
  if (p.id !== room.hostParticipant) return;
  room.hostMail = p.queue.filter((q) => q.seq > p.handedThrough && q.from !== undefined);
}

function enqueue(room: Room, p: Participant, event: RoomServerEvent, bytes = 0, from?: string): void {
  p.queue.push({ seq: p.nextSeq++, event, bytes, ...(from ? { from } : {}) });
  p.queuedBytes += bytes;
  if (p.queue.length > MAX_QUEUED_EVENTS || p.queuedBytes > MAX_QUEUED_BYTES) {
    evict(room, p.id);
    return;
  }
  flushMail(p);
}

/**
 * Would this member's next intent put them over their share of that mailbox?
 *
 * Counted off the queue rather than kept beside it: the acknowledgement already recomputes
 * `queuedBytes` by walking what is left, and a second running total would be the same fact
 * written twice — the pair this repo keeps watching drift.
 */
function wouldBacklog(p: Participant, fromId: string, bytes: number): boolean {
  let events = 0;
  let held = 0;
  for (const q of p.queue) {
    if (q.from !== fromId) continue;
    events += 1;
    held += q.bytes;
  }
  return held + bytes > MAX_OUTSTANDING_BYTES_PER_MEMBER || events + 1 > MAX_OUTSTANDING_EVENTS_PER_MEMBER;
}

function broadcast(room: Room, event: RoomServerEvent, exceptId?: string, bytes = 0, from?: string): void {
  // A copy: an overflowing mailbox evicts its owner, which deletes from the map being walked.
  for (const p of [...room.participants.values()]) {
    if (p.id === exceptId) continue;
    enqueue(room, p, event, bytes, from);
  }
}

/**
 * Answer and forget a parked poll, if there is one — the only way a waiter is ever answered.
 *
 * Answering is also the moment the presence clock restarts. A parked poll *is* the tab being
 * alive, which is why the sweep skips anybody with a waiter; the TTL is meant to measure the
 * silence after it. Mail used to answer the waiter without touching `lastSeen`, so the clock
 * kept the time the poll had *parked* — a poll answered 24 seconds into its park left the
 * re-poll 16 seconds instead of 40, and a phone or a tunnel slower than that was evicted:
 * `peer_left` to the table, the claim dropped, the mic moved on. Three hand-written answers
 * (the park timer, mail, the way out) and only one of them refreshed the clock.
 */
function flushWaiter(p: Participant, result: PollResult): void {
  if (!p.waiter) return;
  clearTimeout(p.waiter.timer);
  p.waiter.resolve(result);
  p.waiter = null;
  p.lastSeen = Date.now();
}

function stopRenameTimer(p: Participant): void {
  if (p.renameTimer) clearTimeout(p.renameTimer);
  p.renameTimer = null;
}

function closeRoom(room: Room, reason: RoomCloseReason): void {
  const event: RoomServerEvent = { type: "room_closed", reason };
  for (const p of room.participants.values()) {
    stopRenameTimer(p);
    flushWaiter(p, { ok: true, seq: p.nextSeq, events: [...p.queue.map((q) => q.event), event] });
  }
  if (room.hostGrace) clearTimeout(room.hostGrace);
  rooms().delete(room.code);
}

/** A participant is gone: seat cleared, the rest told, the host put on the clock. */
function evict(room: Room, id: string): void {
  const p = room.participants.get(id);
  if (!p) return;
  stopRenameTimer(p);
  flushMail(p);
  keepHostMail(room, p);
  room.participants.delete(id);
  markDeparted(room, id);
  if (room.participants.size === 0) room.emptySince = Date.now();
  broadcast(room, { type: "peer_left", id });

  if (id === room.hostParticipant) {
    if (room.hostGrace) clearTimeout(room.hostGrace);
    room.hostGrace = setTimeout(() => closeRoom(room, "host_left"), HOST_GRACE_MS);
    // A dev server dying mid-grace should not keep the process alive for a doomed room.
    room.hostGrace.unref?.();
  }
}

/**
 * Reap what has silently died: participants past the presence TTL, rooms empty past
 * theirs. Lazy — polls arrive constantly, so running on the way into every entry point
 * keeps a clock out of the registry.
 */
function sweep(now = Date.now()): void {
  for (const room of [...rooms().values()]) {
    // The registry deliberately outlives module reloads (dev HMR), which means it can
    // hold rooms minted by an older shape of this file. Fields added later are healed
    // on the way past instead of crashing every entry point until a restart.
    room.retired ??= new Map();
    room.banned ??= new Set();
    room.bannedAddresses ??= new Set();
    room.addresses ??= new Map();
    room.seats ??= new Map();
    room.unseated ??= new Map();
    room.replacements ??= new Map();
    room.hostMail ??= [];
    for (const [id, mintedAt] of room.unseated) {
      if (now - mintedAt < PRESENCE_TTL_MS) continue;
      room.unseated.delete(id);
      room.addresses.delete(id);
      for (const [token, seat] of room.seats) if (seat === id) room.seats.delete(token);
    }
    for (const p of [...room.participants.values()]) {
      if (!p.waiter && now - p.lastSeen >= PRESENCE_TTL_MS) evict(room, p.id);
    }
    for (const [connId, retiredAt] of room.retired) {
      if (now - retiredAt >= PRESENCE_TTL_MS) room.retired.delete(connId);
    }
    if (room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
      if (room.hostGrace) clearTimeout(room.hostGrace);
      rooms().delete(room.code);
    }
  }
}

/**
 * **Is there a chair for this seat — which is not the same question as "is the room full".**
 *
 * The cap counts *arrivals*. Somebody who has sat here before is coming back: a reload, or a
 * phone that slept past the presence TTL and had its chair swept while it was away. They hold
 * a token this room minted and a character still standing in the story, and the two doors
 * disagreed about them — `joinRoom` honours a held seat *before* it counts chairs, while the
 * poll's re-seat counted chairs with no carve-out at all. So a sleeper at a full table woke,
 * polled, and was told "That room is full" (§21.1's third bullet: the fix for that path landed
 * the `nextSeq` half and left this one).
 *
 * One function now, asked by both. "Has sat here" is read off what the registry already
 * keeps — a minted seat is in `unseated` until its first poll removes it — rather than a
 * third flag that could disagree with either.
 */
function roomHasRoomFor(room: Room, id: string): boolean {
  if (hasSatHere(room, id)) return true;
  return room.participants.size < MAX_ROOM_PLAYERS;
}

function hasSatHere(room: Room, id: string): boolean {
  if (room.unseated.has(id)) return false;
  if (id === room.hostParticipant) return true;
  for (const seat of room.seats.values()) if (seat === id) return true;
  return false;
}

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Move a seat that has just gone to the back of the forgetting order.
 *
 * `seats` is walked in insertion order by `forgetLongestAway`, so re-inserting a departing seat's
 * token makes "first in the map" mean "away the longest" among the seats nobody is sitting in.
 */
function markDeparted(room: Room, id: string): void {
  for (const [token, seat] of [...room.seats]) {
    if (seat !== id) continue;
    room.seats.delete(token);
    room.seats.set(token, id);
  }
}

/**
 * Forget the seat that has been away longest, to make room for somebody arriving.
 *
 * Never a seat somebody is sitting in, never the host's, and never a banned one — forgetting a
 * banned token would let it rejoin as a stranger past the token half of the ban.
 */
function forgetLongestAway(room: Room): boolean {
  for (const [token, id] of room.seats) {
    if (room.participants.has(id) || id === room.hostParticipant || room.banned.has(id)) continue;
    room.seats.delete(token);
    room.unseated.delete(id);
    room.addresses.delete(id);
    room.replacements.delete(id);
    return true;
  }
  return false;
}

/** Whether this seat may replace its tab once more right now — and, if so, the replacement counted. */
function mayReplaceTab(room: Room, id: string, now: number): boolean {
  const recent = (room.replacements.get(id) ?? []).filter((at) => now - at < TAB_REPLACEMENT_WINDOW_MS);
  const allowed = recent.length < MAX_TAB_REPLACEMENTS;
  if (allowed) recent.push(now);
  room.replacements.set(id, recent);
  return allowed;
}

/**
 * Tell the table a member's name — now, or once the interval since the last telling has run.
 *
 * Broadcast to everyone *including* the member: their own row is the one on their screen, and a
 * client that had to update it locally as well would be the second writer of a fact the server
 * already owns. The deferred send reads the name *when it fires*, so a burst of keystrokes costs
 * one event carrying the last of them.
 */
function announceName(room: Room, p: Participant): void {
  const now = Date.now();
  const wait = p.renamedAt + RENAME_BROADCAST_INTERVAL_MS - now;
  if (wait <= 0) {
    stopRenameTimer(p);
    p.renamedAt = now;
    broadcast(room, { type: "peer_renamed", id: p.id, name: p.name });
    return;
  }
  if (p.renameTimer) return;
  p.renameTimer = setTimeout(() => {
    p.renameTimer = null;
    if (room.participants.get(p.id) !== p) return;
    p.renamedAt = Date.now();
    broadcast(room, { type: "peer_renamed", id: p.id, name: p.name });
  }, wait);
  p.renameTimer.unref?.();
}

/**
 * Mint a room, and the host's own seat with it.
 *
 * The host is a participant like everybody else and holds a token like everybody else — the
 * version of this that named the host by their *account* is the version where being at a
 * table meant having one. They still seat themselves with their first poll, so a
 * just-created room is empty and its `emptySince` clock is already ticking.
 */
export function createRoom(): { code: string; id: string; token: string } {
  sweep();
  let code: string;
  do {
    code = Array.from(
      { length: ROOM_CODE_LENGTH },
      () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]
    ).join("");
  } while (rooms().has(code));

  const id = randomUUID();
  const token = mintToken();

  rooms().set(code, {
    code,
    hostParticipant: id,
    participants: new Map(),
    seats: new Map([[token, id]]),
    unseated: new Map(),
    retired: new Map(),
    hostMail: [],
    banned: new Set(),
    bannedAddresses: new Set(),
    addresses: new Map(),
    replacements: new Map(),
    emptySince: Date.now(),
    hostGrace: null,
  });
  return { code, id, token };
}

/**
 * Turn a room code into a seat.
 *
 * This is the whole of a guest's credential: they were told six characters and they typed
 * them. What comes back is an id everyone will see and a token only they hold.
 *
 * `address` is where the request came from, kept **only** to make a kick stick — see
 * `Room.bannedAddresses`. It is not stored, not logged here, and not part of the id.
 *
 * `mayMint` is the door's answer to "may this address be handed another new seat right now"
 * (`lib/auth-rate-limit.ts`). It never refuses a held seat — only a new one.
 */
export function joinRoom(
  code: string,
  address: string,
  holding?: string | null,
  { mayMint = true }: { mayMint?: boolean } = {}
): JoinResult {
  sweep();
  const room = rooms().get(code);
  if (!room) return { ok: false, reason: "not_found" };

  /*
   * A token this room already knows is the seat that token already is.
   *
   * Reloading a page must not cost you your character. Without this, every refresh would mint
   * a new participant, and a participant id is what the story's cast member is built from —
   * so the reader would come back as a stranger sitting beside their own abandoned card, with
   * the roster showing both. Idempotent rather than clever: the client always asks, and the
   * answer is the same one until the room forgets it.
   *
   * Checked before `full`, deliberately: somebody who already has a seat is not arriving.
   */
  const held = holding ? room.seats.get(holding) : undefined;
  if (held) {
    if (room.banned.has(held)) return { ok: false, reason: "banned" };
    if (!roomHasRoomFor(room, held)) return { ok: false, reason: "full" };
    return { ok: true, id: held, token: holding as string, isHost: held === room.hostParticipant, minted: false };
  }

  /*
   * The address half of a ban is asked only of somebody *arriving* — after the held seat above.
   *
   * It was asked first, so a guest who shared the kicked guest's public address — the same
   * household, a phone carrier's shared exit — was refused on their next reload while holding a
   * perfectly good seat of their own, and the kicked guest was back a moment later from any other
   * address. A seat already here is not the person the ban is about; the token half of the ban
   * (`banned`) is what refuses the kicked seat itself.
   */
  if (address && room.bannedAddresses.has(address)) return { ok: false, reason: "banned" };

  // Checked here as well as at seat time so a full room refuses at the door, where the
  // client can say so plainly, rather than after it has already been handed a token.
  if (room.participants.size >= MAX_ROOM_PLAYERS) return { ok: false, reason: "full" };
  if (!mayMint) return { ok: false, reason: "busy" };
  if (room.seats.size >= MAX_SEATS_PER_ROOM && !forgetLongestAway(room)) return { ok: false, reason: "full" };

  const id = randomUUID();
  const token = mintToken();
  room.seats.set(token, id);
  room.unseated.set(id, Date.now());
  if (address) room.addresses.set(id, address);
  return { ok: true, id, token, isHost: id === room.hostParticipant, minted: true };
}

/**
 * The seat this token holds in this room, or `null`.
 *
 * The single place a request becomes a participant. A route that resolved an id any other
 * way — reading one out of a body, trusting a query parameter — would let anybody speak as
 * anybody, which is the property `relayIntent`'s `from` has always depended on.
 */
export function seatFor(code: string, token: string | null): string | null {
  if (!token) return null;
  const room = rooms().get(code);
  if (!room) return null;
  return room.seats.get(token) ?? null;
}

/**
 * The down half of the transport: ask for everything after `after`, parking up to
 * `parkMs` when there is nothing yet.
 *
 * The first poll takes the seat `join` minted: it seats the participant, and the *registry*
 * speaks first — `hello` into their fresh mailbox (identity, the roster as it stands),
 * `peer_joined` to everyone else. The same seat polling from a new `connId` replaces its old
 * tab: fresh mailbox, fresh hello, `replaced` to whatever poll the old tab still has parked,
 * and a new `peer_joined` for the rest (the name may have changed — clients upsert by id,
 * they do not append).
 *
 * `after` is the acknowledgement: everything at or below it is delivered and dropped.
 * What remains is answered again until acknowledged — the client skips by sequence, so a
 * response lost on the wire costs a duplicate, never a hole.
 */
export function pollEvents(
  code: string,
  id: string,
  name: string,
  connId: string,
  after: number,
  parkMs: number = POLL_PARK_MS
): Promise<PollResult> {
  sweep();
  const room = rooms().get(code);
  if (!room) return Promise.resolve({ ok: false, reason: "not_found" });

  // A seat this tab already lost. Answered as data, terminally — see `Room.retired`.
  if (room.retired.has(connId)) {
    return Promise.resolve({ ok: true, seq: after, events: [{ type: "replaced" }] });
  }

  // The host removed this seat. Every poll — the one in flight at kick time, a rejoin on the
  // same token, a fresh tab — gets the same terminal answer; the ban is the enforcement.
  if (room.banned.has(id)) {
    return Promise.resolve({ ok: true, seq: after, events: [{ type: "kicked" }] });
  }

  let participant = room.participants.get(id);

  if (participant && participant.connId !== connId && !mayReplaceTab(room, id, Date.now())) {
    return Promise.resolve({ ok: false, reason: "busy" });
  }

  if (participant && participant.connId !== connId) {
    // Another tab of the same seat takes it. The old one's parked poll — if any — is told
    // now; its next poll finds itself retired.
    room.retired.set(participant.connId, Date.now());
    stopRenameTimer(participant);
    keepHostMail(room, participant);
    flushWaiter(participant, {
      ok: true,
      seq: participant.nextSeq,
      events: [{ type: "replaced" }],
    });
    room.participants.delete(id);
    participant = undefined;
  }

  if (!participant) {
    if (!roomHasRoomFor(room, id)) {
      return Promise.resolve({ ok: false, reason: "full" });
    }
    participant = {
      id,
      name,
      connId,
      queue: [],
      queuedBytes: 0,
      /**
       * Numbered from the cursor the caller just showed us, not from zero.
       *
       * A seat evicted by the presence sweep keeps its token, so the tab's *next* poll
       * re-seats it here — while the surviving `RoomConnection` is still acknowledging the
       * cursor it reached before the outage, and its `after` only ever rises. Starting a
       * fresh mailbox at 0 put every new event below that cursor, so the acknowledgement
       * filter below deleted the `hello` this block enqueues twenty lines further down, and
       * then the targeted snapshot, and every relay after it, until `nextSeq` climbed past a
       * number the room could see all along. The guest sat in everyone's roster with a poll
       * answering 200 and a story that had stopped.
       *
       * `after` is the client's own claim and worth nothing as a security fact, which is
       * fine: the only mailbox it can renumber is its own.
       */
      nextSeq: Math.max(0, after + 1),
      waiter: null,
      lastSeen: Date.now(),
      // Never told yet, so the first rename is told at once.
      renamedAt: 0,
      renameTimer: null,
      handedThrough: after,
    };
    room.participants.set(id, participant);
    room.unseated.delete(id);
    room.emptySince = null;
    if (id === room.hostParticipant && room.hostGrace) {
      clearTimeout(room.hostGrace);
      room.hostGrace = null;
    }
    enqueue(room, participant, {
      type: "hello",
      code: room.code,
      you: playerRef(room, participant),
      roster: Array.from(room.participants.values(), (p) => playerRef(room, p)),
    });
    if (id === room.hostParticipant) {
      // After the hello, which is what seats the tab that will apply them.
      const owed = room.hostMail;
      room.hostMail = [];
      for (const q of owed) enqueue(room, participant, q.event, q.bytes, q.from);
    }
    broadcast(room, { type: "peer_joined", player: playerRef(room, participant) }, id);
  } else if (participant.name !== name) {
    /**
     * A rename, carried by the same poll every name has always ridden on.
     *
     * The name was read **once**, at seat time, and ignored on every poll after it — so
     * changing it in the profile left the table calling you what you were called when you
     * sat down, until you rejoined. Nothing said so; the field simply had no effect.
     *
     * Applied at once; told at most once per `RENAME_BROADCAST_INTERVAL_MS` (see there).
     */
    participant.name = name;
    announceName(room, participant);
  }

  participant.lastSeen = Date.now();

  // The acknowledgement: what the client names, the mailbox forgets.
  participant.queue = participant.queue.filter((q) => q.seq > after);
  participant.queuedBytes = participant.queue.reduce((sum, q) => sum + q.bytes, 0);

  if (participant.queue.length > 0) {
    return Promise.resolve(handOut(participant));
  }

  // Nothing yet — park. One waiter per participant: a poll arriving while one is parked
  // is the same tab retrying, and the newcomer wins.
  flushMail(participant);
  return new Promise<PollResult>((resolve) => {
    const p = participant!;
    const timer = setTimeout(() => {
      if (p.waiter?.resolve === resolve) flushMail(p);
      else resolve(handOut(p));
    }, parkMs);
    timer.unref?.();
    p.waiter = { resolve, timer };
  });
}

/**
 * A goodbye, and which kind.
 *
 * `leave` is the Leave button: gone, at once — the claim freed and a mic in their hand moved on.
 * `unload` is a page going away, which cannot say whether it is coming back, and a reload is
 * the commonest reason: the seat token is kept, so the next poll sits back down as the same
 * participant. Evicting on it broadcast `peer_left` a second before that — and `peer_left` is
 * what drops a claimed character and advances the mic. So an unloading seat is released from
 * its parked poll and given `RELOAD_GRACE_MS`; the sweep takes it if nothing polls in that
 * time, and a reload that does poll never tells the table anybody left.
 */
export function leaveRoom(code: string, id: string, reason: LeaveReason = "leave"): void {
  const room = rooms().get(code);
  if (!room) return;
  const p = room.participants.get(id);
  if (!p) return;
  if (reason === "unload") {
    // Released, not handed out: a page going away reads nothing more, so what this answer
    // carries is still owed to the seat's next tab (`Room.hostMail`).
    flushWaiter(p, unacked(p));
    p.lastSeen = Date.now() - PRESENCE_TTL_MS + RELOAD_GRACE_MS;
    return;
  }
  evict(room, id);
}

export type KickResult = "ok" | "not_found" | "not_host" | "not_member";

/**
 * The host removes a player. The registry enforces it — the seat is cleared, the room
 * is told, and the ban above refuses every poll that follows — because a kick a client
 * could ignore is moderation theatre, not moderation.
 */
export function kickPlayer(code: string, byId: string, targetId: string): KickResult {
  sweep();
  const room = rooms().get(code);
  if (!room) return "not_found";
  if (byId !== room.hostParticipant) return "not_host";
  // The host kicking themselves would orphan the room; refuse rather than special-case.
  if (targetId === room.hostParticipant) return "not_member";
  const target = room.participants.get(targetId);
  /*
   * Somebody who has sat here and is away *this second* — reloading, just swept, their phone
   * asleep — is still somebody the host can remove. This answered `not_member` for them and
   * recorded no ban, so their token sat them straight back down. A seat minted and never sat
   * in is still not a member: it has no card and nobody at the table has met it.
   */
  if (!target && !hasSatHere(room, targetId)) return "not_member";

  room.banned.add(targetId);
  const address = room.addresses.get(targetId);
  if (address) room.bannedAddresses.add(address);
  if (!target) return "ok";
  stopRenameTimer(target);
  // Their parked poll — if any — learns now; otherwise their next poll hits the ban.
  flushWaiter(target, {
    ok: true,
    seq: target.nextSeq,
    events: [...target.queue.map((q) => q.event), { type: "kicked" }],
  });
  room.participants.delete(targetId);
  if (room.participants.size === 0) room.emptySince = Date.now();
  broadcast(room, { type: "peer_left", id: targetId });
  return "ok";
}

/**
 * **The host's Kick, pressed on this computer** — the Network panel's guest rows. The same door as
 * the table's own Kick (`kickPlayer`, by the host's seat), so the seat is cleared, its token and
 * address banned and a parked poll told, exactly as when the host presses it in the lobby: one kick
 * per guest, never a second implementation of one.
 */
export function kickFromThisComputer(code: string, targetId: string): KickResult {
  const host = rooms().get(code)?.hostParticipant;
  return host ? kickPlayer(code, host, targetId) : "not_found";
}

/**
 * Carry an intent from one member to the rest — or to one named member. `from` is stamped
 * here, from the seat the route resolved out of the token, never read out of the payload: a
 * client cannot speak as somebody else no matter what it puts in the body.
 *
 * `bytes` is what the intent weighed on the wire, told by the route that read it — the registry
 * does not re-serialise a whole-chat snapshot to find out.
 */
export function relayIntent(
  code: string,
  fromId: string,
  intent: RoomIntent,
  to: string | undefined,
  bytes: number
): RelayResult {
  sweep();
  const room = rooms().get(code);
  if (!room) return "not_found";
  if (!room.participants.has(fromId)) return "not_member";
  if (bytes > ceilingFor(room, fromId)) return "too_large";

  /**
   * A member whose share of a reader's mailbox is spent waits, rather than the reader being
   * thrown out of the room for it. Asked before anything is enqueued, and of every reader
   * this intent is for, so a broadcast cannot go in for some and be refused for the rest.
   */
  if (fromId !== room.hostParticipant) {
    const readers =
      to !== undefined
        ? [room.participants.get(to)]
        : [...room.participants.values()].filter((p) => p.id !== fromId);
    if (readers.some((p) => p && wouldBacklog(p, fromId, bytes))) return "backlogged";
  }

  const event: RoomServerEvent = { type: "relay", from: fromId, intent };
  if (to !== undefined) {
    /**
     * Nobody in that seat is a message that did not land, and the sender is told so. It answered
     * "ok" — a guest's line to a host the sweep had let go was dropped here while their composer
     * cleared on the POST's yes. Refused rather than held: the outbox is serial, and a message
     * held for a guest who has left for good would stall everything the host says after it.
     */
    const target = room.participants.get(to);
    if (!target) return "absent";
    enqueue(room, target, event, bytes, fromId);
  } else {
    broadcast(room, event, fromId, bytes, fromId);
  }
  return "ok";
}

/**
 * The most this seat may put on the wire in one intent — `Infinity` for the host, whose
 * intents carry the whole chat.
 *
 * Exported so the send route can weigh a request's declared length *before* it reads the
 * body: reading first meant the host's process buffered whatever arrived, however far past
 * the ceiling it was, which was the cheap half of filling somebody's mailbox.
 */
export function intentCeiling(code: string, fromId: string): number {
  return ceilingFor(rooms().get(code), fromId);
}

function ceilingFor(room: Room | undefined, fromId: string): number {
  return room && fromId === room.hostParticipant ? Infinity : MAX_GUEST_INTENT_BYTES;
}

/**
 * **Every table here, ended** — the plugin switched off or removed (D4). Each seat is told the host
 * left, as a host closing their tab tells it, so no guest is left polling a door that now answers 404.
 */
/** How many tables this computer hosts right now — what switching the plugin off would end. */
export function roomsOpen(): number {
  sweep();
  return rooms().size;
}

export function closeEveryRoom(): void {
  for (const room of [...rooms().values()]) closeRoom(room, "host_left");
}

/** Everything, gone — a test-only broom, mirroring `closeDb`. */
export function resetRooms(): void {
  for (const room of rooms().values()) {
    if (room.hostGrace) clearTimeout(room.hostGrace);
    for (const p of room.participants.values()) {
      stopRenameTimer(p);
      flushMail(p);
    }
  }
  rooms().clear();
}

/**
 * **Every seat this server has handed out, as the app's network guard reads them**
 * (`ctx.setSeats`): the token that holds it, the table's relay it is good for, and what it may send
 * in one request — the host's seat the app's own ceiling (its intents are whole chats), a guest's
 * one line with its attachments.
 */
export function seatGrants(): PluginSeatGrant[] {
  const grants: PluginSeatGrant[] = [];
  for (const room of rooms().values()) {
    for (const [token, id] of room.seats) {
      grants.push({
        credential: token,
        scope: `${ROOM_MOUNT}/${room.code}`,
        seat: id,
        bodyBytes: id === room.hostParticipant ? "library" : PUBLIC_BODY_BYTES,
      });
    }
  }
  return grants;
}
