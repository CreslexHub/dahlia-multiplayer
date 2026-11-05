import { create } from "zustand";
import { joinPagePath, mintPath, relayPath } from "./join-link";
import { RoomConnection, type WireStatus } from "./connection";
import { joinRefusedReason, ROOM_CODE_LENGTH, type JoinRefusedReason, type PlayerRef, type RoomCloseReason, type RoomIntent, type RoomServerEvent } from "../shared/protocol";
// The ladder is core's (`lib/state/reader.ts`): it reads the table through the port, never this store.
import { ourOwnServer, rememberSeat, rememberedSeat } from "./seat-store";
import { sitDown, sittingAt, standUp } from "./sitting";
import {
  firstRevision,
  isNewer,
  nextRevision,
  readRevision,
  type Revision,
} from "./revision";
import {
  DEFAULT_GUEST_PERMISSIONS,
  DEFAULT_NOTE_SEAL,
  DEFAULT_NOTE_VISIBILITY,
  NOTE_SEAL_ROWS,
  NOTE_VISIBILITY_ROWS,
  type GuestPermissionId,
  type GuestPermissions,
  type NoteSeal,
  type NoteVisibility,
} from "./permissions";
import { forgetTableReading } from "./table-reading";
import { app } from "@dahlia/plugin-api";
import type { FloorView, Seat, TableClock, TurnRules, WindowTally, MicTableView as TableView, ContinueGateProgress, TypingAt, TypingEntry } from "@dahlia/plugin-api";

const { isInlinePicture, TABLE_TALK_PICTURES } = app.cards;
const { isOthersPlayerCard, playerCharacterId, personaCharacterOf, callableCharacters, getSpeakerCharacter, NARRATOR_ID } = app.cast;
const { playerName } = app.identity;
const { TABLE_SEAT, maySpeakNow, playerSeat, seatCharacterId, seatOwnerId, windowCloses, windowFor, speakerOfSeat, turnRulesFor, floorViewFor, windowKeyOf } = app.mic;
const { IS_BUNDLED_APP, apiFetch, joinUrl, normalizeServerAddress, roomFetch, deadlineIn, msLeft } = app.net;
const { mutateChat, readChat, getDisplayName, pipelineFor, turnIsWriting, keepOpen: keepChatsOpenFrom } = app.story;
const { enqueueSpeaker, handOverTurn, holdTurn, nextTurnOffered, nextTurnWaits, turnOwner } = app.turns;

/**
 * The live session, on this device, right now.
 *
 * Deliberately not persisted and not in `ChatSettings`: whose mic, who is connected,
 * whether AI is on — it is coordination between live participants (MULTIPLAYER.md §2.2).
 * Persisting it means a reload replays somebody else's turn; putting a key of it into
 * `DEFAULT_CHAT_SETTINGS` to satisfy settings-coverage is exactly the two-representations
 * bug that test exists to catch. A closed tab forgets all of this, correctly.
 *
 * The host's copy is authoritative (§2.1). Guests apply `session_state` relays and only
 * from the host — a guest POSTing the same intent is ignored by every other guest, because
 * the check is on the *stamped* sender, which the server never lets a client choose.
 */

/**
 * **Host → guests: everything the table has decided, as one versioned value.**
 *
 * It was three channels — `session_state`, `mic_state` and `continue_gate` — each with its own
 * payload, its own validator, and its own list of occasions to re-assert on. The three lists
 * did not agree, and the disagreement was a reported bug: a host reconnecting re-asserted the
 * settings and the mic and **not the gate**, so a guest holding at a gate that no longer
 * existed waited for a table that was not waiting (`.agents/SYNC.md` §3.3).
 *
 * Three facts about one table, sent three ways, is the pair this repo's first law is about.
 * Now there is one fact with one `rev`, one assertion function, and therefore one answer to
 * "what does that guest need to know" — and a guest can tell whether it is current, which is
 * what the whole of §5.2 is for.
 *
 * Declared here, not in the protocol — the server relays intents without reading them, and the
 * vocabulary of kinds belongs to the tabs that speak it.
 */
export const TABLE_STATE_KIND = "table_state";

/**
 * **Who moves the table on.** Both answers move every screen at once — there is no answer under
 * which a Continue releases one screen and leaves the rest where they were.
 *
 * `everyone` holds each gate until every player has pressed: the story moves at the slowest
 * reader's pace, with an X/Y count on the button. `anyone`: the first press, whoever's, moves
 * the whole table on.
 *
 * The second answer was `own_pace`, and it was the one the owner asked to be rid of: a press
 * released *that* screen and nobody else's, so two readers could stand at different places in
 * one story with nothing on either screen saying so — *"it should never mean you press continue
 * and it continues only on your screen."* Live room state, never persisted, so the old id has
 * nowhere to come back from.
 */
export type ContinuePolicy = "everyone" | "anyone";

/** The answers, drawn by the lobby's control and read back off the wire — one list for both. */
export const CONTINUE_POLICY_ROWS: readonly { id: ContinuePolicy; label: string }[] = [
  { id: "everyone", label: "Wait for everyone" },
  { id: "anyone", label: "Anyone moves it on" },
];

/**
 * The turn rules are **not** here, and their absence is the model.
 *
 * `micConfig` rode this payload, was validated on receipt against the policy tables, and was
 * held in the store — a second channel for a fact that is now a chat setting. A host's change
 * reaches guests through the story snapshot they already receive (400 ms debounce, 1200 ms
 * ceiling), so a guest's *picture* can be a beat stale; their **gate** cannot, because the
 * host re-checks `maySpeakNow` against the stamped sender before committing anything
 * (`story-sync.ts`). One less wire kind, one less validator, one less copy to drift.
 *
 * What *is* here is everything the host decides that is not a chat setting — and all of it, so
 * that "what has this guest not been told" is one comparison rather than three.
 */
type TableStatePayload = {
  /** Which generation of the table this is. See `plugins/multiplayer/client/revision.ts`. */
  rev: Revision;
  enableAI: boolean;
  claims: Record<string, string>;
  permissions: GuestPermissions;
  liveTyping: boolean;
  continuePolicy: ContinuePolicy;
  noteVisibility: NoteVisibility;
  noteSeal: NoteSeal;
  /**
   * What a batched window has heard, and the table's clock — the two floor facts that name people
   * and are not already on the chat. Whose turn it is travels in the story snapshot, because it is
   * the chat's turn state (`lib/mic/floor.ts`); a mic holder beside it was a second copy.
   */
  window: WindowTally | null;
  /**
   * The clock as a *duration* — `msLeft`/`deadlineIn`, the one rule for every cross-machine
   * time. A `deadline` here was the host's wall clock, read against each guest's own.
   */
  clock: { of: string; remainingMs: number } | null;
  /** The gates the table is waiting at, oldest first. Empty is as much news as a gate. */
  gates: TableGate[];
  /** What the table's last release went on from — see `wentOn` on the store. */
  wentOn: string[];
  /** Somebody asked the whole table to hold — see `paused` on the store. */
  paused: boolean;
  /** The seat walking the table's reading — see `reader` on the store. */
  reader: string | null;
  /** The seats whose screen shows the story — see `onStory` on the store. */
  onStory: string[];
};

/** The three gate facts, which move together and are written together (`writeGates`). */
type GateState = Pick<TableStatePayload, "gates" | "wentOn" | "paused">;
/** A draft of them, which knows whether it has released anything yet (`releaseIn`). */
type GateDraft = GateState & { releasing?: true };

/**
 * **The table is held at one gate at a time, and the host is the one who says so.**
 *
 * This was a tally per *turn id* — every tab voted for the bubble its own reveal happened
 * to be holding — and that made two ordinary situations unrepresentable-as-agreement:
 *
 *  - two readers holding at different bubbles voted into different buckets, so one screen
 *    read 1/2 and the other 0/2 for what everybody could see was the same wait;
 *  - and a tab that *abandoned* its gate — the host speaks, and `resetReveal` clears the
 *    hold — left everyone else waiting for a vote that could never be cast again. The
 *    story stopped for the guests and nothing on the host's screen said why.
 *
 * Then it was one gate minted on the host with a random name, opened while the host's reveal
 * was held — and *that* left a reader who got to a hold before the host had nowhere to press,
 * so their Continue released their own screen alone, and a reader who arrived at a hold the
 * table had already agreed past was stopped there to press it again by themselves. Two screens
 * at two places in one story, which is the thing the owner asked never to happen
 * (`.agents/SYNC.md` §15).
 *
 * So **a gate is named by where it stands in the story** (`readGateId`), and since ROUND-2026-11-03
 * §2 there is one walker: the seat reading the table (`reader`) holds at it, and every other seat
 * draws that hold. A press can only ever mean "go on from here", and "here" means the same place on
 * every screen, because there is only one "here".
 */
export type TableGate = {
  /**
   * **Which gate this is** — `readGateId(turnId)` for a hold after a bubble, `nextGateId(…)` for
   * the story stopped between two voices.
   *
   * It was a random name minted where the host opened it, which answered *"is this the same
   * gate?"* only for screens that had been told the name — never for one that reached the hold
   * before the host did, which then had no gate to press at all. Derived from the story, every
   * screen can name the gate it is holding at without being told, and the host checks the name
   * rather than issuing it.
   */
  id: string;
  /** The accounts that have said go on. */
  pressed: string[];
};

/** A hold after this bubble — the same name on every screen that holds there. */
export function readGateId(turnId: string): string {
  return `${READ_GATE_PREFIX}${turnId}`;
}
const READ_GATE_PREFIX = "read:";

/**
 * The story stopped between two AI voices after this message — Next turn, as a gate.
 *
 * A gate kind rather than a second tally: Next turn obeys the reading pace exactly as Continue
 * does, so it is counted, released and refused by the same code.
 */
export function nextGateId(lastMessageId: string): string {
  return `${NEXT_GATE_PREFIX}${lastMessageId}`;
}
const NEXT_GATE_PREFIX = "next:";
export function isNextGate(id: string): boolean {
  return id.startsWith(NEXT_GATE_PREFIX);
}

/** Gates open at once — the reader's hold and a Next turn, with room for one being replaced. */
const MAX_OPEN_GATES = 4;

/**
 * Anyone → host: *"go on from here"* — or *"hold, everyone"*.
 *
 * Its own kind, because it is a **request** and not a value: the gates themselves ride
 * `table_state`. A press names every gate this seat is answering — the hold it is parked at, and
 * a Next turn when that is what was pressed — so one press that arrives late, for a wait the table
 * has already walked through, changes nothing instead of half-pressing the next one.
 *
 * `pause` rides the same kind because it is the same conversation: a table-wide hold that any
 * press ends.
 */
export const GATE_PRESS_KIND = "gate_press";
type GatePressPayload = { gates?: string[]; pause?: boolean };

/**
 * Guest → host: *"my screen shows the story"*, or *"it no longer does"* — the room's chat on screen,
 * in front of the reader. What the host names the table's reader from (`tableReaderOf`), so the
 * reading is walked by a screen somebody is looking at, whichever chat the host's own is on.
 */
export const SEAT_VIEW_KIND = "seat_view";
type SeatViewPayload = { onStory: boolean };

/**
 * **Who walks the table's reading** — the one rule (ROUND-2026-11-03 §2).
 *
 * The host, whenever its screen shows the story. Otherwise the seat already reading, while its
 * screen still does, so the reading does not hop between guests as they come and go. Otherwise the
 * first seat in the roster whose screen shows it. Nobody, when no screen does: the reading holds at
 * the bubble in hand, and the next seat to come back takes it there.
 *
 * Pure, and the only place a reader is chosen: the host asks it on every move, and every seat reads
 * the answer off `table_state`.
 */
export function tableReaderOf(
  hostId: string,
  roster: readonly Pick<PlayerRef, "id">[],
  onStory: readonly string[],
  current: string | null
): string | null {
  if (onStory.includes(hostId)) return hostId;
  if (current && onStory.includes(current) && roster.some((p) => p.id === current)) return current;
  return roster.find((p) => p.id !== hostId && onStory.includes(p.id))?.id ?? null;
}

/** Whether a page is out of the reader's sight — a hidden tab's timers pace nothing (MULTIPLAYER.md §8). */
function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** **This tab's screen shows the room's story**, in front of the reader — what it reports, and what the host asks of itself. */
export function showsStory(): boolean {
  const { phase, boundChatId } = useRoomStore.getState();
  return phase === "lobby" && !!boundChatId && app.story.chats.get().activeChatId === boundChatId && !pageHidden();
}

/**
 * Guest → host: *"this is what I hold — send me whatever I am behind on."*
 *
 * The door that did not exist. A guest could not ask, so the only thing that ever repaired a
 * divergence was an unrelated change happening to force a re-send, and a guest who missed the
 * one message that mattered stayed wrong until something else moved (`.agents/SYNC.md` §5.3).
 *
 * **One question, two answers, because there are two authorities behind it**: the store asserts
 * the table (below) and `story-sync.ts` sends the snapshot, each off the same relay. Declared
 * here rather than there because the store cannot import the story sync — the story sync imports
 * the store — and a kind spelled in both places is the pair this repo keeps watching drift.
 *
 * The payload is whatever the asker holds. The store's half ignores it: re-asserting the table
 * is cheap and idempotent, and working out a minimal delta would be a second description of the
 * table that could disagree with the first.
 */
export const RESYNC_REQUEST_KIND = "resync_request";

/**
 * Guest → host: *"I'm ready — close the window for me."*
 *
 * The one thing left for a guest to ask of the floor. Raising a hand and passing a mic went with
 * the orders that had them (TURNS.md §28.3); a person's line and a person's call ride the line
 * itself, and moving the turn is the host's.
 */
export const FLOOR_REQUEST_KIND = "floor_request";
type FloorRequestPayload = { act: "ready" };

/** Which box a person's fingers are in. The wire adds `null` — "I stopped". */

/**
 * Anyone → everyone: fingers on keys, and which box they are in.
 *
 * `at` is three values of one fact — the story composer, the table-talk composer, or
 * `null` for "I stopped". **The stop is told, never inferred from the TTL running out.**
 * Until it existed, only an arriving OOC line cleared its sender's entry; the story path
 * never touched `typing` at all, so "Bo is typing…" stood over an already-delivered
 * message for the rest of the five seconds (TURNS.md §21.8).
 *
 * Throttled at the sender and expired by TTL at every receiver, so a *lost* re-assert
 * still costs five quiet seconds rather than a ghost. `preview` rides only when the host
 * has switched the live keystroke stream on — it is chatty on the wire, which is why it
 * is a setting and why it is off by default.
 */
export const TYPING_KIND = "typing";
type TypingPayload = { at: TypingAt | null; preview?: string };


export const TYPING_TTL_MS = 5_000;
export const TYPING_THROTTLE_MS = 2_000;
export const TYPING_PREVIEW_MAX_CHARS = 120;

/**
 * Guest → host: "let me speak as this character" (`null` — as myself). The host is the
 * one resolver: it validates against the chat it owns and answers with the next
 * `session_state`, so two guests wanting one character are settled by arrival order at
 * a single chair rather than by whoever broadcast last.
 */
export const CLAIM_KIND = "claim_character";

type ClaimPayload = { characterId: string | null };

/**
 * Player ↔ player table talk. Never story prose, never a prompt section — OOC lives and
 * dies with the room, which is why it is here and not on `Chat`. Anyone seated may speak;
 * unlike `session_state` there is no authority check, because there is nothing to be
 * authoritative about.
 */
export const OOC_KIND = "ooc";

/** The words, and the pictures as inline data URLs — the same shape a portrait crosses in. */
type OocPayload = { text: string; images?: string[] };

/** Enough that nobody scrolls off the end of an evening; a bound so a long one cannot leak. */
export const MAX_OOC_MESSAGES = 500;

export type OocMessage = {
  id: string;
  /** The speaker's server-stamped id — display comes from `name`, kept at receipt so a
   *  message survives its author leaving the room. */
  from: string;
  name: string;
  text: string;
  /** Pictures sent with the line. Nothing reads them but the people at the table. */
  images?: string[];
  at: number;
  /**
   * **The outbox gave up on this one**, so nobody else ever saw it.
   *
   * Present only on the sender's own copy, and only after the answer comes back false. A line
   * is appended locally the moment it is typed — the relay excludes its sender, so a round
   * trip would reorder it under latency — and that optimism was the whole of the story: the
   * send's answer was thrown away with a `void`, so a line the room never took stood in the
   * pane looking exactly like a delivered one.
   */
  undelivered?: true;
};

/** A picture on the wire, shape only: an inline image, and nothing else in the slot. */
function oocImagesOf(data: Partial<OocPayload> | undefined): string[] {
  return Array.isArray(data?.images)
    ? data.images.filter(isInlinePicture).slice(0, TABLE_TALK_PICTURES)
    : [];
}

/** A window tally off the wire, shape only — `null` for anything that is not one. */
function readWindow(raw: unknown): WindowTally | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<WindowTally>;
  if (typeof w.of !== "string") return null;
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  const lines: Record<string, number> = {};
  if (w.lines && typeof w.lines === "object") {
    for (const [seat, n] of Object.entries(w.lines)) if (typeof n === "number") lines[seat] = n;
  }
  return { of: w.of, ready: strings(w.ready), lines, calls: strings(w.calls) };
}

export type RoomPhase = "idle" | "connecting" | "lobby" | "ended";
export type RoomEndedReason = JoinRefusedReason | RoomCloseReason | "replaced" | "kicked";

/**
 * Modules that speak their own intent kinds — the story sync above all — watch the
 * room's events here rather than adding branches to `applyRoomEvent`: the store handles
 * the kinds that are *its* state (`session_state`, `ooc`), and everything else belongs
 * to whoever registered. Observers run after the store has applied the event, so they
 * read post-event state.
 *
 * A module-level list, not store state: observers are code, not data, and the store
 * re-rendering because a handler was registered would be noise.
 */
type RoomEventObserver = (event: RoomServerEvent) => void;
const roomEventObservers = new Set<RoomEventObserver>();

export function observeRoomEvents(observer: RoomEventObserver): () => void {
  roomEventObservers.add(observer);
  return () => roomEventObservers.delete(observer);
}

/**
 * What the store needs from a connection — narrow, so a test can hand in a plain object.
 *
 * `send` is deliberately **not** here any more. It resolved `false` on failure and never
 * threw, and thirty-two of its thirty-three callers discarded that — which is the whole of
 * `.agents/SYNC.md` §2. The three verbs that replace it each say what kind of thing is being
 * said, so "may this be dropped?" is answered by the call rather than by whoever wrote it
 * remembering to ask. See `lib/net/outbox.ts`.
 */
export type RoomWire = Pick<RoomConnection, "state" | "event" | "frame" | "close" | "refreshName">;

/**
 * **A guest's one way up to the host** — the verbs of the wire, already addressed.
 *
 * Three guest→host sends named the host and nine did not, so a Director's note written "You
 * only" was carried into every other guest's mailbox to be dropped there on `isHost`, a picture
 * crossed the tunnel once per reader, and the room's per-reader backlog could hold a guest's
 * line behind a *third* guest's sleeping phone — stalling the serial outbox, and every line and
 * gate press behind it, for a reader the line was never for. Nothing was wrong at either end;
 * the address was simply a thing each call site had to remember (`protocol.ts` has the rule).
 *
 * Null when there is nobody to send to: no wire, this tab *is* the host, or the host is away
 * from the room — their seat evicted and not yet back. A broadcast in that last case reached
 * every guest and not the host, whose mailbox is gone with the seat; null says so instead.
 */
type HostDoor = {
  event: (intent: RoomIntent) => Promise<boolean>;
  state: (intent: RoomIntent) => void;
};

export function toHost(): HostDoor | null {
  const { wire, roster, isHost } = useRoomStore.getState();
  if (!wire || isHost) return null;
  const host = roster.find((p) => p.isHost);
  if (!host) return null;
  return {
    event: (intent) => wire.event(intent, host.id),
    state: (intent) => wire.state(intent, host.id),
  };
}

/**
 * Is this chat's AI switched off by the lobby it is being hosted in?
 *
 * The orchestrator's gate for pure human mode: with `enableAI` off the pipeline never
 * starts — not from the composer, not from auto-recovery, not from an approved proposal.
 * Asked of the *host* only; a guest's tab never runs a pipeline at all (`isGuestChatId`
 * refuses first), so this is the half of "no generation" the host's own tab needs.
 */
export function sessionBlocksAI(chatId: string): boolean {
  const s = useRoomStore.getState();
  return s.phase === "lobby" && s.isHost && s.boundChatId === chatId && !s.enableAI;
}

/** The table as the turn walk reads it (`lib/mic/table.ts`) — null while no room plays a chat. */
function tableViewOf(s: Pick<RoomStore, "phase" | "boundChatId" | "roster" | "claims">): TableView | null {
  return s.phase === "lobby" && s.boundChatId
    ? { chatId: s.boundChatId, players: s.roster, claims: s.claims }
    : null;
}

/**
 * **The rules the table is playing by — composed on every read and held nowhere.**
 *
 * They were `roomStore.micConfig`: a copy in the store, a field on the wire and a validator
 * on receipt. Now they are chat settings plus what is derived from the cast, the loop and the
 * roster *as it stands* — which is what makes a player who leaves unrepresentable in the round
 * rather than something a cleanup step has to remember.
 */
export function tableRules(): TurnRules {
  const s = useRoomStore.getState();
  const chat = s.boundChatId ? readChat(s.boundChatId) : undefined;
  return turnRulesFor(chat, tableViewOf(s));
}

/**
 * **The floor at the table playing this chat, derived** — the rules in force and whose turn it is,
 * or null where no room plays it. `floorViewFor` is the whole of the reasoning; this gathers its
 * inputs from the two stores, so the composer's refusal and the host's commit check are asked of
 * one answer.
 */
export function tableFloorFor(chatId: string): { rules: TurnRules; view: FloorView } | null {
  const s = useRoomStore.getState();
  if (s.phase !== "lobby" || s.boundChatId !== chatId) return null;
  const chat = readChat(chatId);
  if (!chat) return null;
  const rules = tableRules();
  const pipeline = pipelineFor(app.story.chats.get(), chatId);
  const view = floorViewFor({
    chat,
    rules,
    table: tableViewOf(s),
    window: s.window,
    generating: { active: turnIsWriting(pipeline), speakerId: pipeline.generatingSpeaker?.id ?? null },
  });
  return { rules, view };
}

/**
 * May *this tab's player* speak in this chat right now — and if not, who has the floor?
 * One derivation for the composer's refusal on both chairs; the host's commit check
 * asks `maySpeakNow` again with the sender's own seat, so a stale screen still cannot
 * slip a line in.
 */
export function micGateFor(chatId: string): { locked: boolean; holderName: string | null } {
  const s = useRoomStore.getState();
  const floor = tableFloorFor(chatId);
  if (!floor || !s.selfId) return { locked: false, holderName: null };
  if (maySpeakNow(floor.rules, floor.view, playerSeat(s.selfId))) {
    return { locked: false, holderName: null };
  }
  const writing = pipelineFor(app.story.chats.get(), chatId).generatingSpeaker?.name ?? null;
  return { locked: true, holderName: seatDisplayName(floor.view.up) ?? writing };
}

/** A seat as a person would say it: the player's lobby name, the character's own, or the table. */
export function seatDisplayName(seat: Seat | null): string | null {
  if (!seat) return null;
  if (seat === TABLE_SEAT) return "The table";
  const s = useRoomStore.getState();
  const ownerId = seatOwnerId(seat);
  if (ownerId) return s.roster.find((p) => p.id === ownerId)?.name ?? "Someone";
  const charId = seatCharacterId(seat);
  if (!charId || charId === NARRATOR_ID) return "Narrator";
  const chat = s.boundChatId ? readChat(s.boundChatId) : undefined;
  return chat?.characters?.find((c) => c.id === charId)?.name ?? "A character";
}

/** Everything a gate's count is read from, as one `Pick` for the selectors that subscribe to it. */
export type GateFacts = Pick<RoomStore, "phase" | "continuePolicy" | "roster" | "gates" | "selfId" | "pressing">;

/**
 * Gate `id` as this seat should draw it, or null where there is no table to draw it for — no
 * room, or nobody else seated (a press still goes through the table then, and moves it at once).
 * A gate the host has not opened yet — this screen got there first — reads as nobody pressed.
 * Pure over the state so React selectors and plain readers compute the same answer; completeness
 * is derived against the roster *as it stands*, which is how a player leaving mid-vote completes a
 * gate on its own.
 */
export function gateProgressOf(s: GateFacts, id: string): ContinueGateProgress | null {
  if (s.phase !== "lobby" || s.roster.length < 2) return null;
  const gate = s.gates.find((g) => g.id === id) ?? { id, pressed: [] };
  const count = s.roster.filter((p) => gate.pressed.includes(p.id)).length;
  /**
   * **`mine` is "have I answered", not "has the host counted me".**
   *
   * The two are the same once the round trip completes and different for the length of it, and
   * the version before this made them the same by *writing into the host's tally* — so a press
   * whose send failed left a seat reading "waiting" against a count nobody else had. The count
   * beside the button now only ever says what the table has actually heard; `pressing` says
   * what this seat did, and is cleared the moment the host's copy answers either way.
   */
  const answered =
    (!!s.selfId && gate.pressed.includes(s.selfId)) ||
    s.pressing.includes(id);
  return {
    id,
    counted: s.continuePolicy === "everyone",
    pressed: count,
    total: s.roster.length,
    mine: answered,
    // The release rule's own terms (`settleIn`): every seat, or the host pressing for the table.
    complete: count >= s.roster.length || s.roster.some((p) => p.isHost && gate.pressed.includes(p.id)),
  };
}

/** What the table's reading says about the gates — `syncGates`' one argument. */
export type HostGateView = {
  /** The hold the table's reading is parked at (`readGateId`), or null — a pause's hold has none. */
  hold: string | null;
  /** …with the next bubble in hand, so a Continue stands under it and the table's gate is open. */
  offered: boolean;
  /** The Next turn the table would be offered now (`nextGateId`), or null. */
  next: string | null;
  /** A turn of the story is being written. */
  generating: boolean;
};

/** The open Next turn, if the table is stopped between two voices. */
export function openNextGate(s: Pick<RoomStore, "gates">): TableGate | null {
  return s.gates.find((g) => isNextGate(g.id)) ?? null;
}

/** The newest hold the table is waiting at — what a screen with no hold of its own answers. */
export function openReadGate(s: Pick<RoomStore, "gates">): TableGate | null {
  for (let i = s.gates.length - 1; i >= 0; i--) if (!isNextGate(s.gates[i].id)) return s.gates[i];
  return null;
}

/**
 * Extract room code and optional host address from raw join input (code, host, or full URL).
 */
export function parseRoomJoinInput(
  rawCode: string,
  rawHost?: string | null
): { code: string; hostAddress: string | null } {
  const trimmedCode = (rawCode || "").trim();
  const trimmedHost = (rawHost || "").trim();

  // If the code input itself looks like a URL (e.g. https://xxx.trycloudflare.com/chat?room=ABCDEF or https://xxx.trycloudflare.com#ABCDEF)
  if (/^https?:\/\//i.test(trimmedCode)) {
    try {
      const url = new URL(trimmedCode);
      const origin = url.origin;
      const paramCode =
        url.searchParams.get("room") ||
        url.searchParams.get("code") ||
        url.searchParams.get("id") ||
        url.hash.replace(/^#/, "");
      let pathCode = "";
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length > 0 && pathParts[pathParts.length - 1].length === ROOM_CODE_LENGTH) {
        pathCode = pathParts[pathParts.length - 1];
      }
      const code = (paramCode || pathCode || "").trim().toUpperCase();
      return {
        code,
        hostAddress: origin,
      };
    } catch {
      // Fall through on URL parse error
    }
  }

  const hostAddress = trimmedHost ? normalizeServerAddress(trimmedHost) : null;
  return {
    code: trimmedCode.toUpperCase(),
    hostAddress: hostAddress || null,
  };
}

export interface RoomStore {
  phase: RoomPhase;
  wireStatus: WireStatus;
  code: string | null;
  hostAddress: string | null;
  /** The secret this tab's seat was minted with. See `AT_REST`. */
  seatToken: string;
  selfId: string | null;
  isHost: boolean;
  roster: PlayerRef[];
  enableAI: boolean;
  endedReason: RoomEndedReason | null;
  error: string | null;
  wire: RoomWire | null;
  ooc: OocMessage[];
  /** Messages that arrived while the OOC surface was not being looked at. */
  oocUnread: number;
  /**
   * The chat this room plays. The host names it when hosting; a guest learns it from
   * the first story snapshot. Live session state like everything here — the durable
   * half is the chat's own `multiplayer` marker.
   */
  boundChatId: string | null;
  /**
   * The binding this tab has already walked into (`PlayTogetherModal`) — once per binding, and
   * here rather than in the dialog, because the dialog is mounted by each screen and a ref in it
   * was new on every one: a player who went home from the table was sent straight back to it,
   * and so was every other chat they opened. Cleared with the room.
   */
  walkedInto: string | null;
  /**
   * Who speaks as whom: account owner → character id on the bound chat. The host's copy
   * is the real one; guests apply what `session_state` carries. A player with no claim
   * speaks as their own minted card (`playerCharacterId`), which needs no entry here.
   */
  claims: Record<string, string>;
  /**
   * What guests may do to the shared story — `plugins/multiplayer/client/permissions.ts` is the table.
   * Host-authoritative like everything here; a guest's copy only decides which controls
   * their screen offers, never what the host applies.
   */
  permissions: GuestPermissions;
  /** What the batched window has heard — see `WindowTally`. The host's copy counts; guests draw what is broadcast. */
  window: WindowTally | null;
  /** The table's clock — a person's turn or the window — stamped by the host. See `TableClock`. */
  clock: TableClock | null;
  /** Whether keystrokes stream as ghost previews — host's switch, off by default. */
  liveTyping: boolean;
  /** Who is typing right now, and where: owner → entry. TTL-swept at render. */
  typing: Record<string, TypingEntry>;
  /** How the table reads — see `ContinuePolicy`. Host edits, rides `session_state`. */
  continuePolicy: ContinuePolicy;
  /**
   * Who at the table may read a Director's note, and what stands where one they may not
   * read would have been — `plugins/multiplayer/client/permissions.ts` holds both tables and the rule.
   *
   * Host-authoritative like every right here, and enforced where the snapshot *leaves*: a
   * guest's copy of these decides nothing at all, because the text they may not read never
   * reaches their tab.
   */
  noteVisibility: NoteVisibility;
  noteSeal: NoteSeal;
  /** The gates the table is waiting at — see `TableGate`. The host opens, tallies and releases them. */
  gates: TableGate[];
  /**
   * **What the table's last release went on from** — the reader's hold, and a Next turn when that
   * was what was pressed. The reader lets go of a hold named here, and every seat draws a Next turn
   * named here as starting. Replaced by the next release, never accumulated.
   *
   * It replaced `released`, a list of the last 64 gates the table had moved past, which existed so a
   * screen that walked its own reveal and got to a hold late could walk through it. With one walker
   * nobody is late (ROUND-2026-11-03 §2), and the walker only needs to hear the one release it is
   * waiting for.
   */
  wentOn: string[];
  /**
   * **The seat walking the table's reading**, or null while no seat's screen shows the story. The host
   * names it (`tableReaderOf`, the one rule) and every seat reads it: the reader walks and publishes,
   * everyone else draws what it published, and the host lands.
   */
  reader: string | null;
  /** The seats whose screen shows the story, visible — what `tableReaderOf` chooses among. Host-kept, told. */
  onStory: string[];
  /**
   * **Somebody asked the whole table to hold.** Every screen holds after the bubble in hand, and
   * any Continue lets them all go. A pause used to be the pressing tab's alone, so the host
   * pausing stopped the host and every guest read on.
   */
  paused: boolean;
  /**
   * The gates **this seat** has answered, until the host's tally says so.
   *
   * Not a second copy of a gate's `pressed`: that is the host's, and a guest writing into it was a
   * tab agreeing with itself about a fact it does not own. This says only "I pressed at that
   * gate", so the button can read "waiting" the instant it is pressed while the count beside it
   * stays honest about what the table has actually heard.
   */
  pressing: string[];

  /**
   * Sit down at a table. Neither of these takes a name any more — it is the reader's
   * profile (`getDisplayName`), read by the wire on every poll, so hosting and joining ask
   * for a story and a code and nothing about who you are.
   */
  hostRoom: (chatId: string) => Promise<void>;
  joinRoom: (code: string, hostAddress?: string | null) => Promise<void>;
  /** The profile name just changed: tell the table now instead of at the next poll. */
  announceName: () => void;
  leaveRoom: () => void;
  setEnableAI: (on: boolean) => void;
  /** Ask to speak as a character (`null` — as yourself). Host applies; guests request. */
  requestClaim: (characterId: string | null) => void;
  /** The host's resolver — the only writer of `claims`. Guest tabs refuse. */
  assignClaim: (ownerId: string, characterId: string | null) => void;
  /** Grant or revoke one guest right — host only, like `setEnableAI`. */
  setGuestPermission: (id: GuestPermissionId, granted: boolean) => void;
  /** Who may read a note, and what a note they may not read looks like. Host only. */
  setNoteVisibility: (visibility: NoteVisibility) => void;
  setNoteSeal: (seal: NoteSeal) => void;
  /**
   * **Bring the table's own facts in line with the chat** — host only, idempotent.
   *
   * Called whenever the chat, the run or the roster moves. It stamps the clock for whoever is up
   * (a clock is keyed by the turn it times, so asking twice stamps once), and closes a window the
   * table as it now stands has finished — a player leaving can be the last one it was waiting on.
   * There is no restart, no stranded holder and no per-mode arm: whose turn it is is the chat's.
   */
  syncFloor: () => void;
  /** Settle a clock that has already run out. Idempotent; see `runExpiry` and its three doors. */
  checkExpiry: () => void;
  /** "I'm ready" in a batched window — with the call an empty send carried, if any. Host applies; guests request. */
  pressReady: (calling?: string | null) => void;
  /** The host closes a batched window now, whoever has not pressed Ready. */
  closeWindow: () => void;
  /**
   * A person's line went into a batched window — count it, and file the call it carried. Host only;
   * the host's composer and a guest's committed line are the two callers.
   */
  windowLine: (ownerId: string, calling: string | null) => void;
  /**
   * The host hands the turn to a seat — a face tapped on the strip. A voice is *called*, which a
   * person may always do; a person is handed the floor.
   */
  moveTurnTo: (seat: Seat) => void;
  /** Switch the live keystroke stream — host only, rides `session_state`. */
  setLiveTyping: (on: boolean) => void;
  /** Choose how the table reads — host only, rides `session_state`. */
  setContinuePolicy: (policy: ContinuePolicy) => void;
  /**
   * **Bring the table's gates in line with the table's reading** — host only, idempotent.
   *
   * Called by the watcher in `plugins/multiplayer/client/continue-gate.ts` on every move of either store, like
   * `syncFloor`. It opens the gate the reader's reveal is offering, opens and closes the Next turn,
   * settles a gate a leaver has completed, and goes on from a hold the reading has moved off (the
   * host speaking, a retry), so the reader is not left waiting for a press nobody can cast.
   */
  syncGates: (view: HostGateView) => void;
  /**
   * **Name the seat reading the table** — host only, idempotent: `tableReaderOf` over who is on the
   * story now, the host's own screen included (`hostOnStory`). Called by the same watcher.
   */
  syncReader: (hostOnStory: boolean) => void;
  /** This seat's screen shows the story, or stopped showing it. Guests tell the host; the host asks its own screen. */
  reportOnStory: (on: boolean) => void;
  /**
   * "Go on from here" — at each gate named. Host applies its own; guests send theirs up. An empty
   * list still ends a table-wide pause, which is what a Continue under a pause means.
   */
  pressGates: (ids: readonly string[]) => void;
  /** Hold the whole table after the bubble each screen has in hand. Host applies; guests ask. */
  pauseTable: () => void;
  /**
   * Say fingers are on keys, and in which box. An empty draft is a **stop**.
   *
   * Throttled here; callers just call it per keystroke. A stop and a change of box go out
   * at once — a throttled correction leaves the wrong surface standing for two seconds,
   * and a throttled stop leaves a promise standing over a line that has already landed.
   */
  reportTyping: (draft: string, at: TypingAt) => void;
  /**
   * Drop what somebody was typing, because the line it promised has arrived here.
   *
   * The local arrival is the trigger, never a comparison of timestamps: `until` is stamped
   * on the *receiving* machine and a `Message.timestamp` on the *writing* one, so a table
   * whose clocks disagree would either hide every draft or clear none of them, silently.
   */
  clearTyping: (ownerId: string) => void;
  /**
   * Remove a player from the table — host only; the server enforces the removal.
   *
   * Answers with the sentence to show when the room did *not* take it, or null when it did (or
   * when there was nothing to ask): the removal itself arrives as `peer_left` like any other.
   */
  kickPlayer: (ownerId: string) => Promise<string | null>;
  sendOoc: (text: string, images?: readonly string[]) => void;
  markOocRead: () => void;

  /** The connection's event callback. An action so tests drive the same path the wire does. */
  applyRoomEvent: (event: RoomServerEvent) => void;
  setWireStatus: (status: WireStatus) => void;
}

/**
 * Back to rest — and the table's revision with it.
 *
 * `tableRev` is module state, so a `set({ ...atRest() })` on its own would leave the *next*
 * session's first assertion looking older than the last one's last, and a guest would ignore
 * the table it had just sat down at. One function, so a fifth place that ends a session cannot
 * forget the half that is not in the object.
 */
function atRest(): typeof AT_REST {
  tableRev = null;
  heardEvents.clear();
  hostHold = null;
  startingNext = null;
  onStorySent = false;
  forgetTableReading();
  return AT_REST;
}

/**
 * **The hold the table's reading was parked at, last time it was asked** — host only.
 *
 * The one thing `syncGates` needs to remember rather than read: when the reading leaves a hold —
 * released, cut short by the host speaking, reset by a retry — its gate is over, and "it has left"
 * is only visible as a difference from before. What the table is told is the result.
 */
let hostHold: string | null = null;

/**
 * What the host believes about this guest's screen showing the story: what this guest last told it,
 * corrected by every `table_state` (a host that reloaded, a report lost). A report is sent only when
 * the screen and this disagree, so it is said once per change, and again only when the host forgot.
 */
let onStorySent = false;

/**
 * **The Next turn this host has released and is starting** — so `syncGates` does not reopen the
 * same wait in the instant between the release and the run saying it is writing. Cleared once
 * the run is seen; if it then ends with nothing written, the same wait is a fresh one.
 */
let startingNext: string | null = null;

const AT_REST = {
  phase: "idle" as RoomPhase,
  wireStatus: "closed" as WireStatus,
  code: null,
  hostAddress: null as string | null,
  /**
   * The secret half of this tab's seat. Public id is `selfId`; this is what proves it.
   *
   * Held in the store rather than only inside the wire because `kickPlayer` builds its own
   * request — the host's one piece of authority over the table, and the registry checks it
   * against the room's host, so it has to be able to say which seat is asking.
   */
  seatToken: "",
  selfId: null,
  isHost: false,
  roster: [] as PlayerRef[],
  enableAI: true,
  endedReason: null,
  error: null,
  wire: null,
  ooc: [] as OocMessage[],
  oocUnread: 0,
  boundChatId: null,
  walkedInto: null as string | null,
  claims: {} as Record<string, string>,
  permissions: { ...DEFAULT_GUEST_PERMISSIONS },
  window: null as WindowTally | null,
  clock: null as TableClock | null,
  liveTyping: false,
  typing: {} as Record<string, TypingEntry>,
  continuePolicy: "everyone" as ContinuePolicy,
  noteVisibility: DEFAULT_NOTE_VISIBILITY,
  noteSeal: DEFAULT_NOTE_SEAL,
  gates: [] as TableGate[],
  wentOn: [] as string[],
  paused: false,
  reader: null as string | null,
  onStory: [] as string[],
  pressing: [] as string[],
};

/**
 * **The generation of the table this tab is speaking or hearing.**
 *
 * On the host it is the authority's own counter, stepped by `assertTable`. On a guest it is
 * what was last applied, and a `table_state` that is not newer than it is ignored. Module
 * state beside the store because nothing renders from it — what a screen draws is the *values*
 * the revision came with.
 *
 * It replaces `gateSeq`, which was a counter over one of the three facts this now carries, and
 * which restarted on a reload while the room it was numbering lived on.
 */
let tableRev: Revision | null = null;

/**
 * **The events this tab has already applied, by sender** — the far side of `RoomIntent.eventId`.
 *
 * The outbox retries a POST it has no answer for, and "no answer" includes a POST the room took
 * and whose response was lost, so the room can carry one event twice. Nothing downstream could
 * tell: a guest's line was committed twice, and an edit or delete addressed to chunk 2 of a
 * reply was applied again to whatever chunk had moved into that place.
 *
 * Here rather than at each intent handler because it is a property of the transport, not of a
 * kind — a handler per kind would be a list of the kinds somebody remembered. A ring per sender,
 * because an evening of intents must not be remembered for ever and a retry only ever repeats
 * something recent. Module state beside `tableRev`, and cleared with it when a session ends.
 */
const heardEvents = new Map<string, string[]>();
const HEARD_EVENTS_PER_SENDER = 256;

/** Whether this event has been applied here already — and, if it has not, that it now has. */
function heardBefore(from: string, eventId: string): boolean {
  const heard = heardEvents.get(from) ?? [];
  if (heard.includes(eventId)) return true;
  heard.push(eventId);
  if (heard.length > HEARD_EVENTS_PER_SENDER) heard.shift();
  heardEvents.set(from, heard);
  return false;
}

/**
 * The host's turn clock. Module state beside the store (one session per tab): armed on
 * every floor write, and only ever on the host — a guest deciding anything from a local
 * timer is the drift the broadcast deadline exists to prevent.
 */
let clockTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The last thing this tab said about its own fingers, module state for the same reason.
 *
 * The *value* is held beside the clock because the throttle only applies to saying the
 * same thing again: a start, a stop and a move from one box to the other are all changes
 * of `at`, and every one of them has to go out at once.
 */
let typingSent: { at: TypingAt | null; when: number } = { at: null, when: 0 };

export const useRoomStore = create<RoomStore>((set, get) => {
  function playerSeats(): Seat[] {
    return get().roster.map((p) => playerSeat(p.id));
  }

  /**
   * **Say what the table has decided — the one door, host only.**
   *
   * Replaces `broadcastMicState`, `broadcastTableGate` and the three-line
   * `wire.state(sessionStateIntent(get()))` that every setter carried. Those were three
   * channels with three re-assert lists, and the lists did not agree: a reconnecting host
   * re-asserted the settings and the mic and skipped the gate, which is the reported soft lock.
   *
   * Every host change ends here, and so does every occasion a reader needs catching up on — a
   * join, a reconnect, a resync request. One function, so a fourth occasion cannot be added
   * with two of the three facts in it.
   *
   * The revision is stepped **before** the send and the new one is written to the store first,
   * because writing the store runs the subscribers — and one of those may release a reveal and
   * close the very gate being described. Sending a value read back afterwards is how the old
   * `broadcastTableGate` came to send "no gate" twice and the completing tally never at all.
   */
  function assertTable(to?: string, becoming?: GateState): void {
    const { isHost, wire } = get();
    if (!isHost || !wire) return;
    const rev = tableRev ? nextRevision(tableRev) : firstRevision();
    tableRev = rev;
    const s = get();
    wire.state(
      {
        kind: TABLE_STATE_KIND,
        data: {
          rev,
          enableAI: s.enableAI,
          claims: s.claims,
          permissions: s.permissions,
          liveTyping: s.liveTyping,
          continuePolicy: s.continuePolicy,
          noteVisibility: s.noteVisibility,
          noteSeal: s.noteSeal,
          window: s.window,
          clock: s.clock ? { of: s.clock.of, remainingMs: msLeft(s.clock.deadline)! } : null,
          gates: (becoming ?? s).gates,
          wentOn: (becoming ?? s).wentOn,
          paused: (becoming ?? s).paused,
          reader: s.reader,
          onStory: s.onStory,
        } satisfies TableStatePayload,
      },
      to
    );
  }

  /**
   * **Say the gate, then write it** — the one field where that order is load-bearing.
   *
   * Writing the store runs its subscribers synchronously, and one of them is the watcher that
   * may release this tab's reveal and *close this very gate*. So a completing tally written
   * first is a tally that has already been replaced by `null` before anything reads it back:
   * the room is told "no gate" twice and never hears who finally pressed.
   *
   * Every other field is safe the ordinary way round — nothing re-enters on a permission or a
   * mic write — so this is the exception rather than the rule, and it is a named function so
   * that it cannot be half-remembered at one of the places that move the gates.
   *
   * Refuses a write that changes nothing, because its callers run on every store move — and an
   * assertion per keystroke would be a wire full of the same table.
   */
  function writeGates(next: GateDraft): void {
    const s = get();
    const gates: GateState = { gates: next.gates, wentOn: next.wentOn, paused: next.paused };
    if (
      s.paused === gates.paused &&
      JSON.stringify(s.gates) === JSON.stringify(gates.gates) &&
      JSON.stringify(s.wentOn) === JSON.stringify(gates.wentOn)
    ) {
      return;
    }
    assertTable(undefined, gates);
    set(gates);
  }

  /** The gates as they stand, as a draft the host's rules can change and write once. */
  function gateDraft(): GateDraft {
    const { gates, wentOn, paused } = get();
    return { gates: gates.map((g) => ({ id: g.id, pressed: [...g.pressed] })), wentOn: [...wentOn], paused };
  }

  /**
   * **The table goes on from `id`** — and from every hold opened before it, which the reading can
   * only have left behind. The first release of a draft replaces what the table last went on from;
   * a second in the same draft (a Next turn, and the hold its press reads on from) joins it. A Next
   * turn released also starts the turn, once the draft is written (`commitGates`), so the run starts
   * against what every screen has been told.
   */
  function releaseIn(draft: GateDraft, id: string): void {
    if (draft.releasing && draft.wentOn.includes(id)) return;
    const at = draft.gates.findIndex((g) => g.id === id);
    const behind = isNextGate(id) ? [] : draft.gates.slice(0, Math.max(0, at)).filter((g) => !isNextGate(g.id));
    const going = [...behind.map((g) => g.id), id];
    draft.gates = draft.gates.filter((g) => !going.includes(g.id));
    draft.wentOn = draft.releasing ? [...draft.wentOn, ...going.filter((g) => !draft.wentOn.includes(g))] : going;
    draft.releasing = true;
  }

  /**
   * **Every open gate the table as it now stands has finished** — the owner's rule (ROUND-2026-11-03
   * §2): under "Anyone moves it on" one press from any seat; under "Wait for everyone" every seat, or
   * the host pressing for the table. A leaver can be the last one owed.
   */
  function settleIn(draft: GateDraft): string[] {
    const { roster, continuePolicy } = get();
    const host = roster.find((p) => p.isHost)?.id;
    const done = draft.gates
      .filter((g) =>
        continuePolicy === "anyone"
          ? g.pressed.length > 0
          : (!!host && g.pressed.includes(host)) || roster.every((p) => g.pressed.includes(p.id))
      )
      .map((g) => g.id);
    for (const id of done) releaseIn(draft, id);
    return done;
  }

  /**
   * **Whether a released Next turn may start its turn** — the one door a press from any seat
   * opens, the host's own included (`commitGates` is where it starts).
   *
   * Asked again here rather than trusted from the gate, because the story can have moved between
   * the press and its arrival: a line sent, a run already going. Then the press was for a wait
   * that is over, and nothing starts.
   */
  function nextTurnStartable(id: string): boolean {
    const { boundChatId, enableAI } = get();
    const chat = boundChatId ? readChat(boundChatId) : undefined;
    if (!boundChatId || !chat || !enableAI) return false;
    // The terms the gate was opened on (`nextTurnOffered`), so a pill the table draws can start.
    const pipeline = pipelineFor(app.story.chats.get(), boundChatId);
    if (pipeline.isGenerating || !nextTurnOffered(chat, pipeline)) return false;
    const last = chat.messages[chat.messages.length - 1];
    return !!last && nextGateId(last.id) === id;
  }

  /**
   * Write the draft, then start the Next turn it released, if it did.
   *
   * `startingNext` is set **before** the write: writing runs the watcher, which runs `syncGates`,
   * which would otherwise see the wait still standing (the run has not said it is writing yet) and
   * open it again under the press that had just closed it.
   */
  function commitGates(draft: GateDraft, released: readonly string[]): void {
    const starting = released.find((id) => isNextGate(id) && nextTurnStartable(id)) ?? null;
    if (starting) startingNext = starting;
    writeGates(draft);
    const { boundChatId } = get();
    if (starting && boundChatId) {
      app.turns.start(boundChatId, { generation: "normal" });
    }
  }

  /**
   * The host's one tally-keeper, its own presses included. A press names the gates it is for, so
   * one that arrives late — for a gate the table has already walked through — changes nothing
   * rather than half-pressing the next one; and one for a Next turn the host is no longer offering
   * is refused the same way.
   *
   * A hold the host has not opened is opened only by **the reader's** press: the reader is at it by
   * definition, and its press can overtake the reading that would have opened it. Anyone else is
   * drawing the reader's hold, which the host opened before relaying it, so a press for any other
   * hold is for a place nobody is reading at. There used to be a tally for a guest ahead of the host,
   * because every guest walked its own reveal; with one walker nobody is ahead (ROUND-2026-11-03 §2).
   *
   * Any press ends a table-wide pause — asking for the next bubble is asking for the queue back.
   */
  function hostApplyPress(fromOwner: string, ids: readonly string[]): void {
    if (!get().roster.some((p) => p.id === fromOwner)) return;
    const draft = gateDraft();
    draft.paused = false;
    for (const id of ids) {
      // Late: the table has just gone on from it, and opening it again would hold the reader there.
      if (draft.wentOn.includes(id)) continue;
      let gate = draft.gates.find((g) => g.id === id);
      if (!gate) {
        // A Next turn only exists where the host opened it; a hold only where the reader stands.
        if (isNextGate(id) || fromOwner !== get().reader) continue;
        gate = { id, pressed: [] };
        draft.gates.push(gate);
        if (draft.gates.length > MAX_OPEN_GATES) draft.gates.shift();
      }
      if (!gate.pressed.includes(fromOwner)) gate.pressed.push(fromOwner);
    }
    commitGates(draft, settleWithNext(draft));
  }

  /**
   * A released Next turn reads on as well: in solo the press that starts the next voice also lets
   * go of the hold the reply stopped at (`requestTurn`), and at a table the same press must not
   * leave every screen parked behind a turn that is already being written.
   */
  function settleWithNext(draft: GateDraft): string[] {
    const done = settleIn(draft);
    if (done.some(isNextGate) && hostHold) releaseIn(draft, hostHold);
    return done;
  }

  /** Every host-side floor write lands here: write, re-arm the clock, tell the room. */
  function setFloor(patch: Partial<Pick<RoomStore, "window" | "clock">>): void {
    set(patch);
    armClock();
    assertTable();
  }

  function armClock(): void {
    if (clockTimer) {
      clearTimeout(clockTimer);
      clockTimer = null;
    }
    const { isHost, clock } = get();
    if (!isHost || !clock) return;
    clockTimer = setTimeout(runExpiry, Math.max(0, clock.deadline - Date.now()));
  }

  /**
   * The clock ran out — **checked, not merely scheduled.**
   *
   * A `setTimeout` was the only clock, and browsers clamp and freeze timers in hidden tabs.
   * Background the host's tab for two minutes and the table sat at "0s" while every guest waited
   * on a turn nobody could take. So expiry is checked on every door back into the tab: the timer,
   * the page becoming visible, and the next inbound room event. A frozen timer costs latency
   * instead of the evening.
   *
   * What running out *means* is read off the floor as it stands, not off the clock: a clock keyed
   * to a turn that has already moved on counts nothing down. The window closes; a person's seat is
   * passed as if they had sent nothing.
   */
  function runExpiry(): void {
    clockTimer = null;
    const { isHost, clock, boundChatId } = get();
    if (!isHost || !clock || !boundChatId) return;
    if (Date.now() < clock.deadline) {
      armClock();
      return;
    }
    const floor = tableFloorFor(boundChatId);
    const chat = readChat(boundChatId);
    if (!floor || !chat || clock.of !== clockKeyOf(chat, floor.view)) {
      setFloor({ clock: null });
      return;
    }
    if (floor.view.up === TABLE_SEAT) {
      closeWindowNow(false);
      return;
    }
    setFloor({ clock: null });
    passTurnOf(boundChatId);
  }

  /**
   * Which turn a clock times: the AI line being answered, and whose place it is. Null — nothing to
   * time. Not the gap between two voices, even batched where the gap is the window: a voice is owed
   * there, and the gap has a clock of its own (a Pause) or waits for Next turn by design.
   */
  function clockKeyOf(chat: Parameters<typeof windowKeyOf>[0], view: FloorView): string | null {
    return view.up && !view.gap ? `${windowKeyOf(chat)}|${view.up}` : null;
  }

  /** Ask the story to write the turn the chat says is owed — if the AI is on and it is not waiting on Next turn. */
  function startOwedTurn(chatId: string): void {
    const chat = readChat(chatId);
    if (!chat || !get().enableAI) return;
    if (turnOwner(chat).nextOwner !== "ai" || nextTurnWaits(chat)) return;
    app.turns.start(chatId);
  }

  /** The person whose place is up gave it up with nothing said — a clock, a leaver. */
  function passTurnOf(chatId: string): void {
    mutateChat(chatId, (draft) => handOverTurn(draft, null, { passing: true }));
    startOwedTurn(chatId);
  }

  /**
   * **Close the window and hand the story its turn.**
   *
   * `asked` is whether people closed it — every player Ready, the last line of a cap, the host's
   * button. Then the turn starts even where the chat waits for Next turn, because a person asking *is*
   * the Next turn. A clock running out or a player leaving is the table's own motion, and waits.
   *
   * The calls the players' lines carried are answered first, in the order they were sent; with none,
   * the rules say who answers — whoever carries on, a voice drawn at random, or the round's next
   * entry. A window nobody wrote a line in gives the table's place in the round up, as an empty
   * send gives a person's.
   */
  function closeWindowNow(asked: boolean): void {
    const { boundChatId, window } = get();
    const chat = boundChatId ? readChat(boundChatId) : undefined;
    if (!boundChatId || !chat) return;
    const tally = windowFor(window, windowKeyOf(chat));
    const wrote = Object.values(tally.lines).some((n) => n > 0);
    // Shut before the chat moves, not after: the write below re-derives the floor (`syncFloor`
    // runs on every chat change), and a floor still open to the table — the gap between two voices
    // is (`floorViewFor`) — found this same finished tally standing and closed it again, for ever.
    setFloor({ window: null, clock: null });
    mutateChat(boundChatId, (draft) => {
      const calls = tally.calls.filter((id) => id === NARRATOR_ID || callableCharacters(draft).some((c) => c.id === id));
      if (calls.length === 0) {
        handOverTurn(draft, null, { passing: !wrote });
        return;
      }
      handOverTurn(draft, calls[0]);
      for (const id of calls.slice(1)) enqueueSpeaker(draft, id);
    });
    if (!asked) {
      startOwedTurn(boundChatId);
      return;
    }
    const closed = readChat(boundChatId);
    if (closed && get().enableAI && turnOwner(closed).nextOwner === "ai") {
      app.turns.start(boundChatId);
    }
  }

  /** The window's tally after `change`, written — and the window closed, where that finished it. */
  function updateWindow(change: (tally: WindowTally) => WindowTally): void {
    const { boundChatId, window } = get();
    const floor = boundChatId ? tableFloorFor(boundChatId) : null;
    const chat = boundChatId ? readChat(boundChatId) : undefined;
    if (!floor || !chat || !floor.rules.batch) return;
    const next = change(windowFor(window, windowKeyOf(chat)));
    setFloor({ window: next });
    if (windowCloses(floor.rules, next, playerSeats(), false)) closeWindowNow(true);
  }

  /**
   * The host's one resolver for a floor request, its own included. A Ready counts only in an open
   * window, and only from somebody at the table — a press from a player who has left, or one that
   * arrives after the window shut, changes nothing.
   */
  function hostApplyFloorRequest(fromOwner: string, req: FloorRequestPayload): void {
    const { isHost, boundChatId, roster } = get();
    if (!isHost || req.act !== "ready" || !boundChatId) return;
    if (!roster.some((p) => p.id === fromOwner)) return;
    if (tableFloorFor(boundChatId)?.view.up !== TABLE_SEAT) return;
    const seat = playerSeat(fromOwner);
    updateWindow((tally) => (tally.ready.includes(seat) ? tally : { ...tally, ready: [...tally.ready, seat] }));
  }

  function appendOoc(message: OocMessage, opts: { unread: boolean }): void {
    set((s) => ({
      // Capped from the front: the bound exists so an evening of table talk cannot grow
      // without limit, and the end being dropped would be the messages being read.
      ooc: [...s.ooc, message].slice(-MAX_OOC_MESSAGES),
      oocUnread: opts.unread ? s.oocUnread + 1 : s.oocUnread,
    }));
  }

  function connectTo(code: string, token: string, hostAddress?: string | null): void {
    const targetHost = hostAddress ? normalizeServerAddress(hostAddress) : null;
    const wire = new RoomConnection(
      code,
      // Read per poll, from the profile — nobody is asked for a name on the way in any more.
      // `playerName` stays the one normaliser: a reader who has never set one is "Player"
      // here, exactly as a guest with an empty field always was.
      () => playerName(getDisplayName()),
      {
        onEvent: (event) => get().applyRoomEvent(event),
        onStatus: (status) => get().setWireStatus(status),
        // A refusal is an HTTP status on the poll; folded back into the event vocabulary
        // so endings have one path through the store.
        onRefused: (reason) => get().applyRoomEvent({ type: "join_refused", reason }),
      },
      token,
      targetHost
    );
    // A new table has never been told anything about these fingers, so the throttle starts
    // again with it — otherwise the first keystroke after a rejoin is swallowed as a repeat.
    typingSent = { at: null, when: 0 };
    set({ ...atRest(), phase: "connecting", code, wire, seatToken: token, hostAddress: targetHost });
    wire.connect();
  }

  return {
    ...atRest(),

    hostRoom: async (chatId) => {
      get().leaveRoom();
      set({ phase: "connecting", error: null });
      try {
        const res = await apiFetch(mintPath(), { method: "POST" });
        if (!res.ok) throw new Error(`room refused: ${res.status}`);
        const { code, token } = (await res.json()) as { code: string; token: string };
        rememberSeat(null, code, token);
        connectTo(code, token);
        // After connectTo — it resets to AT_REST on the way in.
        set({ boundChatId: chatId });
      } catch {
        set({ ...atRest(), error: "Couldn't create a room. Check the connection and try again." });
      }
    },

    joinRoom: async (codeOrUrl, hostAddress) => {
      const parsed = parseRoomJoinInput(codeOrUrl, hostAddress);
      /**
       * **Somebody else's server is joined on its own page.**
       *
       * Joining from here posts to that server across sites, which its middleware refuses as it
       * must (a cross-site write), answering a preflight only for the bundled app's own origin
       * (`APP_ORIGINS`). So a pasted tunnel or LAN address could never join from a browser tab —
       * the packaged window on `localhost` included — and said "Couldn't reach that table" about
       * a table that was there. The host's own join page is that server's page, so it is where a
       * served page goes; only the bundled app, which is allowed across, joins in place.
       */
      if (parsed.hostAddress && !IS_BUNDLED_APP && !ourOwnServer(parsed.hostAddress)) {
        globalThis.location?.assign(joinUrl(parsed.hostAddress, joinPagePath(parsed.code)));
        return;
      }
      get().leaveRoom();
      set({ phase: "connecting", code: parsed.code, error: null });

      /*
       * The code is spent here, once, and never again.
       *
       * It used to be that the first poll *was* the join, because the caller already had an
       * account and the code only had to name a room. A code is the whole credential now
       * (`.agents/ACCESS.md` §3), so it is exchanged at a door of its own — which is also the
       * only place that can be rate-limited, and the only place that can tell "no such room"
       * from "that room is full" before anybody is sitting down.
       */
      const path = relayPath(parsed.code, "join");
      const held = rememberedSeat(parsed.hostAddress, parsed.code);
      let res: Response;
      try {
        res = await roomFetch(joinUrl(parsed.hostAddress ?? "", path), held, { method: "POST" });
      } catch {
        set({ ...atRest(), error: "Couldn't reach that table. Check the link and try again." });
        return;
      }

      if (!res.ok) {
        /**
         * **The door's own word, not an inference from the status.**
         *
         * `joinRoom` answers `not_found`, `full` or `banned` and the route puts that word in
         * the body; this read the status — 403 or 409 meant "full" — so a kicked guest coming
         * back was told the room was full. A status is three answers wide and the reasons are
         * not, which is the shape: the producer already knows, so it says.
         *
         * The status is still the fallback, for a refusal that carries no reason at all — the
         * rate limiter's, or a proxy's.
         */
        const said = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const reason: JoinRefusedReason =
          joinRefusedReason(said?.error) ??
          (res.status === 404 ? "not_found" : res.status === 429 ? "busy" : "full");
        // Folded into the event vocabulary so every ending reaches the screen one way.
        get().applyRoomEvent({ type: "join_refused", reason });
        return;
      }

      const { token } = (await res.json()) as { token: string };
      rememberSeat(parsed.hostAddress, parsed.code, token);
      connectTo(parsed.code, token, parsed.hostAddress);
    },

    /**
     * ── What a rename reaches, and what it does not ──────────────────────────────────────
     *
     * The wire re-reads the profile on every poll, so this only decides *when* the table
     * hears — it cuts the parked poll rather than waiting out its twenty-five seconds.
     *
     * **It reaches:** the roster on every screen (the server updates the participant and
     * broadcasts `peer_renamed`), and therefore every surface drawn from a roster name — the
     * seats, the lobby, the turn strip, the mic's holder, the typing line. And, on the
     * host's tab, the guest's **character card in the story**, but *only while that card is
     * still bare* (`wearsLobbyName` in `story-sync.ts`): a card they brought or filled in is
     * theirs and keeps its own name, which is the same rule a claimed cast member follows.
     *
     * **It does not reach:**
     *
     *  - **OOC lines already said.** `OocMessage.name` is resolved at receipt, on purpose —
     *    the name has to survive its author leaving the room, and a line attributed to
     *    nobody is worse than a line attributed to who they were.
     *  - **Story messages already committed.** A message names a *character*, not an
     *    account, so a bubble follows the card — which means a bare card's past lines do
     *    re-title themselves and a brought card's do not, exactly as above.
     *  - **Anyone who is not connected.** The roster is live session state and dies with the
     *    room (MULTIPLAYER §2.2). A player who was here an hour ago is not renamed
     *    retroactively anywhere, because there is nowhere holding them.
     *  - **The account's own username.** That is a credential on the server
     *    (`lib/server/users.ts`) and is only changed from `.env.local`. This name is a label
     *    and shares its *rule* with that one, never its storage.
     */
    announceName: () => {
      get().wire?.refreshName();
    },

    leaveRoom: () => {
      get().wire?.close();
      if (clockTimer) {
        clearTimeout(clockTimer);
        clockTimer = null;
      }
      typingSent = { at: null, when: 0 };
      set({ ...atRest() });
    },

    setEnableAI: (on) => {
      // Guests see this control disabled; refusing here too keeps a future keyboard
      // shortcut or stale component from silently forking the host's copy.
      if (!get().isHost) return;
      set({ enableAI: on });
      assertTable();
      /**
       * Switched back on, the turn the table was waiting on gets written. Nothing starts while AI
       * is off — that is the switch being real — so a voice owed a turn sat owed until somebody
       * asked again. Whatever the chat says is owed is what starts; a Next turn still waits.
       */
      const { boundChatId } = get();
      if (on && boundChatId) startOwedTurn(boundChatId);
    },

    requestClaim: (characterId) => {
      const { isHost, selfId } = get();
      if (!selfId) return;
      if (isHost) {
        get().assignClaim(selfId, characterId);
        return;
      }
      toHost()?.state({ kind: CLAIM_KIND, data: { characterId } satisfies ClaimPayload });
    },

    assignClaim: (ownerId, characterId) => {
      const { isHost, boundChatId, claims, roster } = get();
      if (!isHost) return;
      if (characterId) {
        // Your own minted card is always yours; the cast is claimable only where the
        // chat marks it player-controlled, and only while nobody else holds it.
        const own = characterId === playerCharacterId(ownerId);
        if (!own) {
          /**
           * Nobody wears an account's card but that account.
           *
           * The ladder below cannot answer this. A seat that is already holding a *cast*
           * claim resolves at rung 1 and never mentions the card minted for it, so
           * `takenByAnother` reported that card free and a second guest could take it —
           * speak as them, and inherit edit and delete over every line they had spoken as
           * it, under rights that are on by default. It is the exploit the comment below
           * records as fixed, one rung further down: the fix guarded the host's persona,
           * and a claim moves any seat onto the same rung.
           *
           * Asked as "is this somebody else's" rather than "is it taken", because a minted
           * card is an identity and not a chair — free is not a state it has.
           */
          if (isOthersPlayerCard(characterId, ownerId)) return;
          const chat = boundChatId ? readChat(boundChatId) : undefined;
          const char = chat?.characters?.find((c) => c.id === characterId);
          if (!char || char.roleSetting !== "user") return;
          /**
           * ...and the same rung, for the chat's own persona.
           *
           * `personaCharacterOf` is the host's identity without a claim, so the moment the
           * host claims somebody from the cast their seat also answers at rung 1 and the
           * persona reads free to the walk below. Only the host may wear it.
           */
          const persona = chat ? personaCharacterOf(chat) : null;
          const claimantIsHost = roster.find((p) => p.id === ownerId)?.isHost ?? false;
          if (persona && persona.id === characterId && !claimantIsHost) return;
          /**
           * ...and last, the thing a claim is actually for: first claim wins.
           *
           * A cast member is held only by an explicit pick, so `claims` is the whole record
           * of who has one and this scan is the whole rule.
           *
           * This used to be a walk over every seat through `tableCharacterFor`, to catch the
           * two identities that are worn *without* being claimed. That was too clever by
           * exactly one rung: the ladder answers with the first rung that resolves, so a seat
           * already holding a cast claim stopped at rung 1 and never mentioned the identity
           * underneath it — which is how a guest could take another guest's minted card, or
           * the host's persona once the host had claimed somebody. Those two are refused
           * above by name now, each as its own sentence, and what is left here is the
           * contention rule that has no rungs to get lost in.
           */
          const heldByAnother = Object.entries(claims).some(
            ([owner, held]) => held === characterId && owner !== ownerId
          );
          if (heldByAnother) return;
        }
      }
      const next = { ...claims };
      if (characterId) next[ownerId] = characterId;
      else delete next[ownerId];
      set({ claims: next });
      assertTable();
    },

    setGuestPermission: (id, granted) => {
      const { isHost, permissions } = get();
      if (!isHost) return;
      set({ permissions: { ...permissions, [id]: granted } });
      assertTable();
    },

    /**
     * Changing either of these changes what every guest is *allowed to hold*: the notes on
     * their screens were redacted under the old answer, and no chat mutation is coming to
     * revisit them. `story-sync` watches this pair for exactly that and re-sends the story —
     * from there, because that is where the redaction lives and this module may not import it.
     */
    setNoteVisibility: (visibility) => {
      if (!get().isHost) return;
      set({ noteVisibility: visibility });
      assertTable();
    },

    setNoteSeal: (seal) => {
      if (!get().isHost) return;
      set({ noteSeal: seal });
      assertTable();
    },

    checkExpiry: () => runExpiry(),

    syncFloor: () => {
      const { isHost, boundChatId, clock, window } = get();
      if (!isHost || !boundChatId) return;
      const floor = tableFloorFor(boundChatId);
      const chat = readChat(boundChatId);
      if (!floor || !chat) return;
      // A window the table as it now stands has finished closes — somebody leaving can be the last
      // player it was waiting on. Asked of the stored tally only while it is about this window.
      if (floor.view.up === TABLE_SEAT && window && window.of === windowKeyOf(chat)) {
        if (windowCloses(floor.rules, window, playerSeats(), false)) {
          closeWindowNow(false);
          return;
        }
      }
      // The clock, keyed by the turn it times — so asking again for the same turn stamps nothing.
      const key = floor.rules.playerTurnSeconds === null ? null : clockKeyOf(chat, floor.view);
      if (key === null) {
        if (clock) setFloor({ clock: null });
        return;
      }
      if (clock?.of === key) return;
      setFloor({ clock: { of: key, deadline: Date.now() + floor.rules.playerTurnSeconds! * 1000 } });
    },

    pressReady: (calling = null) => {
      const { isHost, selfId } = get();
      if (!selfId) return;
      if (isHost) {
        // The host's own call rides in with the press; a guest's composer carries none yet.
        if (calling) updateWindow((tally) => (tally.calls.includes(calling) ? tally : { ...tally, calls: [...tally.calls, calling] }));
        hostApplyFloorRequest(selfId, { act: "ready" });
        return;
      }
      void toHost()?.event({ kind: FLOOR_REQUEST_KIND, data: { act: "ready" } satisfies FloorRequestPayload });
    },

    closeWindow: () => {
      const { isHost, boundChatId } = get();
      if (!isHost || !boundChatId) return;
      if (tableFloorFor(boundChatId)?.view.up !== TABLE_SEAT) return;
      closeWindowNow(true);
    },

    windowLine: (ownerId, calling) => {
      if (!get().isHost) return;
      const seat = playerSeat(ownerId);
      updateWindow((tally) => ({
        ...tally,
        lines: { ...tally.lines, [seat]: (tally.lines[seat] ?? 0) + 1 },
        calls: calling && !tally.calls.includes(calling) ? [...tally.calls, calling] : tally.calls,
      }));
    },

    moveTurnTo: (seat) => {
      const { isHost, boundChatId } = get();
      if (!isHost || !boundChatId) return;
      const chat = readChat(boundChatId);
      if (!chat) return;
      const speaker = speakerOfSeat(chat, tableViewOf(get()), seat);
      const card = getSpeakerCharacter(chat, speaker);
      mutateChat(boundChatId, (draft) => {
        // A person is handed the floor; a voice is called, which a person may always do.
        if (card && card.roleSetting === "user") {
          holdTurn(draft, card.id);
        } else {
          handOverTurn(draft, seatCharacterId(seat) ?? NARRATOR_ID);
        }
      });
      if (!(card && card.roleSetting === "user")) {
        app.turns.start(boundChatId);
      }
    },

    setLiveTyping: (on) => {
      if (!get().isHost) return;
      set({ liveTyping: on });
      assertTable();
    },

    /**
     * The policy and the gates are one state with one writer, so they move in one write: a press
     * already cast under `everyone` is, under `anyone`, somebody having moved the table on.
     */
    setContinuePolicy: (policy) => {
      if (!get().isHost) return;
      set({ continuePolicy: policy });
      const draft = gateDraft();
      const done = settleWithNext(draft);
      // Says the policy as well: `writeGates` asserts whenever the gates move, and when they do
      // not this is the one assertion the new policy gets.
      if (done.length === 0) assertTable();
      commitGates(draft, done);
    },

    syncGates: (view) => {
      const { isHost, phase } = get();
      if (!isHost || phase !== "lobby") return;
      const draft = gateDraft();
      const released: string[] = [];

      /**
       * **The table's reading left a hold, so the table has.** Released by the table, cut short by
       * the host speaking, reset by a retry: its gate is over, and a count standing for it would be
       * a press nobody can cast. A hand-over keeps the hold: the reading taken over stands where the
       * table was (`tableReadingOf`), so the view does not move.
       */
      if (hostHold && hostHold !== view.hold && draft.gates.some((g) => g.id === hostHold)) {
        releaseIn(draft, hostHold);
        released.push(hostHold);
      }
      hostHold = view.hold;

      // The reader's offer is the table's gate. Never closed by the offer lapsing — a new run
      // displacing the parked one drops the offer for a tick and keeps the hold (`claimReveal`).
      if (view.hold && view.offered && !draft.wentOn.includes(view.hold) && !draft.gates.some((g) => g.id === view.hold)) {
        draft.gates.push({ id: view.hold, pressed: [] });
      }

      /**
       * The Next turn, open exactly while the host's own screen would offer it. A wait the host
       * released and is starting stays released until the run is seen; one released whose run then
       * wrote nothing is a fresh wait for the same place, and opens again.
       */
      if (view.generating) startingNext = null;
      draft.gates = draft.gates.filter((g) => !isNextGate(g.id) || g.id === view.next);
      if (view.next && !draft.gates.some((g) => g.id === view.next) && startingNext !== view.next) {
        draft.wentOn = draft.wentOn.filter((id) => id !== view.next);
        draft.gates.push({ id: view.next, pressed: [] });
      }
      if (draft.gates.length > MAX_OPEN_GATES) draft.gates.splice(0, draft.gates.length - MAX_OPEN_GATES);

      commitGates(draft, [...released, ...settleWithNext(draft)]);
    },

    syncReader: (hostOnStory) => {
      const { isHost, phase, selfId, onStory, roster, reader } = get();
      if (!isHost || phase !== "lobby" || !selfId) return;
      const seen = hostOnStory ? [...new Set([selfId, ...onStory])] : onStory.filter((id) => id !== selfId);
      const here = roster.filter((p) => seen.includes(p.id)).map((p) => p.id);
      const next = tableReaderOf(selfId, roster, here, reader);
      if (next === reader && JSON.stringify(here) === JSON.stringify(onStory)) return;
      set({ reader: next, onStory: here });
      assertTable();
    },

    reportOnStory: (on) => {
      const { isHost, phase } = get();
      if (isHost || phase !== "lobby" || onStorySent === on) return;
      const host = toHost();
      if (!host) return;
      onStorySent = on;
      // A state, so a change made while the wire is down is the one that arrives.
      host.state({ kind: SEAT_VIEW_KIND, data: { onStory: on } satisfies SeatViewPayload });
    },

    pressGates: (ids) => {
      const { isHost, selfId } = get();
      if (!selfId) return;
      if (isHost) {
        hostApplyPress(selfId, ids);
        return;
      }
      /**
       * **A guest records that it pressed, and never writes into the tally.**
       *
       * It used to push its own id into the gate's `pressed` — the *authoritative* value — so a
       * press whose POST failed left the guest reading "Waiting" forever against a count the host
       * had never heard of, and the two copies of one fact disagreed with nothing able to notice.
       * `pressing` is the tab's own business: it names the gates this seat has answered, the button
       * reads it, and the host's tally is the only thing that counts.
       *
       * The send is a `state`, so a press made while the wire is down is retried and a press for a
       * gate the table has since left is replaced by the newer one rather than queueing.
       */
      set({ pressing: [...new Set([...get().pressing, ...ids])] });
      toHost()?.state({ kind: GATE_PRESS_KIND, data: { gates: [...ids] } satisfies GatePressPayload });
    },

    pauseTable: () => {
      const { isHost, selfId, phase } = get();
      if (!selfId || phase !== "lobby") return;
      if (isHost) {
        writeGates({ ...gateDraft(), paused: true });
        return;
      }
      // An event, not a state: it shares a kind with the press, and as a state it would replace a
      // press still queued — losing the Continue that press carried.
      void toHost()?.event({ kind: GATE_PRESS_KIND, data: { pause: true } satisfies GatePressPayload });
    },

    kickPlayer: async (ownerId) => {
      const { isHost, code, hostAddress, seatToken, roster } = get();
      if (!isHost || !code) return null;
      const name = roster.find((p) => p.id === ownerId)?.name ?? "that player";
      /**
       * The registry answers with `peer_left` for everyone and `kicked` for the target; nothing
       * to apply locally — the roster update arrives like any other.
       *
       * **The answer is read.** It was a `void` with no status check and no `catch`: a kick the
       * room refused, or one that never reached it, looked from the host's side exactly like a
       * kick still on its way, so the person stayed in the roster with nothing saying why — and a
       * dropped network was an unhandled rejection besides.
       */
      try {
        const res = await roomFetch(
          joinUrl(hostAddress ?? "", relayPath(code, "kick")),
          seatToken,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: ownerId }),
          }
        );
        return res.ok ? null : `The room would not remove ${name} — they are still at the table.`;
      } catch {
        return `Couldn't reach the room to remove ${name} — check the connection and try again.`;
      }
    },

    reportTyping: (draft, at) => {
      const { phase, wire, liveTyping } = get();
      if (phase !== "lobby" || !wire) return;
      const next: TypingAt | null = draft.trim() ? at : null;
      const now = Date.now();
      if (next === typingSent.at) {
        // Nothing to stop, and nothing anybody has not already been told.
        if (next === null) return;
        if (now - typingSent.when < TYPING_THROTTLE_MS) return;
      }
      typingSent = { at: next, when: now };
      const payload: TypingPayload = {
        at: next,
        ...(next && liveTyping ? { preview: draft.slice(0, TYPING_PREVIEW_MAX_CHARS) } : {}),
      };
      wire.frame({ kind: TYPING_KIND, data: payload });
    },

    clearTyping: (ownerId) => {
      if (!get().typing[ownerId]) return;
      const { [ownerId]: _landed, ...rest } = get().typing;
      set({ typing: rest });
    },

    sendOoc: (text, images = []) => {
      const trimmed = text.trim();
      const { wire, selfId, roster } = get();
      if ((!trimmed && images.length === 0) || !wire || !selfId) return;
      const pictures = images.slice(0, TABLE_TALK_PICTURES);
      // The relay excludes its sender, so our own line is appended here — the one writer
      // for what we said, instead of a round trip that would reorder under latency.
      const id = crypto.randomUUID();
      appendOoc(
        {
          id,
          from: selfId,
          name: roster.find((p) => p.id === selfId)?.name ?? "You",
          text: trimmed,
          ...(pictures.length > 0 ? { images: pictures } : {}),
          at: Date.now(),
        },
        { unread: false }
      );
      /**
       * **The answer is read, not thrown away.**
       *
       * `event` resolves false when the outbox gives up — the room ending under a guest, or
       * the ring evicting the oldest after a bad minute — and this was the one typed surface
       * that discarded it with a `void`. The line stood in the sender's pane, indistinguishable
       * from one the table had heard, and nothing anywhere said otherwise.
       *
       * Marked rather than taken back: the words are still worth having, and unlike the story
       * composer there is no box left to put them into.
       */
      void wire
        .event({
          kind: OOC_KIND,
          data: { text: trimmed, ...(pictures.length > 0 ? { images: pictures } : {}) } satisfies OocPayload,
        })
        .then((landed) => {
          if (landed) return;
          set((s) => ({ ooc: s.ooc.map((line) => (line.id === id ? { ...line, undelivered: true } : line)) }));
        });
    },

    markOocRead: () => set({ oocUnread: 0 }),

    applyRoomEvent: (event) => {
      // A retried event the room carried twice is the same event, applied once.
      if (event.type === "relay" && typeof event.intent.eventId === "string" && heardBefore(event.from, event.intent.eventId)) {
        return;
      }
      // Before the event, not after: an inbound message is proof the tab is running again,
      // and a turn whose clock expired while it was frozen has to be settled before this
      // event is applied on top of a floor that should already have moved on.
      runExpiry();
      applyBuiltInEvent(event);
      // After the built-ins: an observer reads the store post-event (a `peer_joined`
      // observer sees the newcomer already in the roster).
      for (const observer of roomEventObservers) observer(event);
    },

    setWireStatus: (status) => set({ wireStatus: status }),
  };

  function applyBuiltInEvent(event: RoomServerEvent): void {
      switch (event.type) {
        case "hello": {
          // Every hello is a full reset, not a delta — a reconnect re-joins and the
          // roster it carries is the truth, including who we are this time.
          onStorySent = false;
          set({
            phase: "lobby",
            code: event.code,
            selfId: event.you.id,
            isHost: event.you.isHost,
            roster: event.roster,
            endedReason: null,
            error: null,
          });
          // A host reconnecting into a lobby that still has guests re-asserts the
          // settings; a fresh host broadcasts to nobody, harmlessly.
          if (event.you.isHost) {
            /**
             * A claim is a chair, and whoever left while this tab was away never told it so: the
             * `peer_left` that releases one went to a mailbox the room had let go of with the host.
             * The roster this hello carries is who is here, so a claim by anybody else is released
             * — as that `peer_left` would have — before the table is told what it holds.
             */
            const here = new Set(event.roster.map((p) => p.id));
            const claims = get().claims;
            if (Object.keys(claims).some((owner) => !here.has(owner))) {
              set({ claims: Object.fromEntries(Object.entries(claims).filter(([owner]) => here.has(owner))) });
            }
            assertTable();
            armClock();
            // Nothing to start: whose turn it is is the chat's, and a clock or a window a table
            // needs is stamped from the chat as it stands (`syncFloor`).
            get().syncFloor();
          }
          break;
        }
        case "peer_joined": {
          // Upsert by id: a rejoin arrives as another peer_joined, possibly renamed.
          const rest = get().roster.filter((p) => p.id !== event.player.id);
          set({ roster: [...rest, event.player] });
          if (get().isHost) {
            assertTable(event.player.id);
          }
          break;
        }
        case "peer_renamed": {
          // A name and nothing else. Everything that hangs off a *join* — the session
          // settings, the mic, the gate, the story snapshot — is deliberately not re-sent
          // here; the roster row is the whole of what changed.
          set({
            roster: get().roster.map((p) =>
              p.id === event.id ? { ...p, name: event.name } : p
            ),
          });
          break;
        }
        case "peer_left": {
          const { isHost: hosting, boundChatId: leftChat } = get();
          // Asked before the roster forgets them: was it their place the round was waiting on?
          const theirTurn = hosting && leftChat ? tableFloorFor(leftChat)?.view.up === playerSeat(event.id) : false;
          set({ roster: get().roster.filter((p) => p.id !== event.id), onStory: get().onStory.filter((id) => id !== event.id) });
          // A reader who left hands the reading on, by the same rule that named them.
          if (hosting) get().syncReader(showsStory());
          // Their fingers left with them. On every screen, not just the host's: the promise
          // is drawn from this map, and a bubble in the story owed to somebody who has gone
          // is the stalest promise there is.
          get().clearTyping(event.id);
          // A claim is a seat at the table; leaving vacates it for the next player.
          if (hosting && get().claims[event.id]) {
            get().assignClaim(event.id, null);
          }
          if (hosting && leftChat) {
            /**
             * A turn held for somebody who has gone moves on. The round without them has no place
             * for them, so the walk's next entry is the one after theirs — computed from the round's
             * position on the transcript, not from their seat, which is why it does not restart at
             * the head the way a rigid loop that filtered its roster first used to (TURNS.md §26.1).
             */
            if (theirTurn) {
              mutateChat(leftChat, (draft) => handOverTurn(draft, null));
              startOwedTurn(leftChat);
            }
            // ...and a window they were the last one it waited on closes behind them.
            get().syncFloor();
          }
          break;
        }
        case "relay": {
          if (event.intent.kind === TABLE_STATE_KIND) {
            /**
             * **Everything the table has decided, applied or ignored as one.**
             *
             * Three branches stood here — the settings, the mic, the gate — each with its own
             * authority check and its own field-by-field validation, and each able to be
             * current while the other two were stale. One value with one revision cannot be:
             * a guest either holds this generation of the table or it does not.
             *
             * The authority check is unchanged and is the load-bearing one: only the host's
             * copy is real, and `from` is stamped by the server, so it cannot be defeated from
             * a guest's keyboard.
             */
            const host = get().roster.find((p) => p.isHost);
            if (!host || event.from !== host.id) break;
            const data = event.intent.data as Partial<TableStatePayload> | undefined;
            const rev = readRevision(data?.rev);
            // Older than what this tab holds, or unversioned: nothing to learn. A newer epoch
            // is a new authority — a host that reloaded — and its word replaces whatever was
            // being held, however high the old count had climbed.
            if (!rev || !isNewer(rev, tableRev)) break;
            tableRev = rev;

            /**
             * **A versioned whole value is applied as a whole value.**
             *
             * Every field below falls back to `AT_REST`'s answer — never to whatever this tab
             * happened to be holding — and they all land in **one** `set`.
             *
             * It was eight writes, each guarded with "if this field is well-formed" and each
             * leaving the old value standing when it was not, *after* `tableRev` had already been
             * advanced. So a field the host did not send left the tab believing it held generation
             * N while holding N−1's answer for that one field, with nothing on either side able to
             * tell: the two-copies-of-one-fact shape this channel exists to delete, re-created
             * inside it (`.agents/SYNC.md` §11.4).
             *
             * `permissions` already read this way — rebuilt over the shipped defaults, keyed rows
             * only — and so does the run projection, which falls back to `IDLE_PIPELINE`. This is
             * the same discipline for the rest of the table. Eight writes becoming one is the
             * other half of it: a guest's subscribers used to see seven half-applied generations
             * on the way to each one that was true.
             */
            const claims: Record<string, string> = {};
            if (data?.claims && typeof data.claims === "object") {
              for (const [owner, held] of Object.entries(data.claims)) {
                if (typeof held === "string") claims[owner] = held;
              }
            }
            // Over the defaults, keyed rows only: a host running a build with more or
            // fewer rows than this one must not leave holes or smuggle strangers in.
            const permissions = { ...DEFAULT_GUEST_PERMISSIONS };
            if (data?.permissions && typeof data.permissions === "object") {
              for (const [key, value] of Object.entries(data.permissions)) {
                if (key in permissions && typeof value === "boolean") {
                  permissions[key as GuestPermissionId] = value;
                }
              }
            }
            // The turn rules used to arrive here as a `micConfig` field with thirty lines of
            // validation behind it. They are chat settings now and ride the story snapshot
            // the guest already receives, so there is nothing left to validate — and one
            // fewer copy that could disagree with the gate the host enforces.
            // The window's tally and the clock, validated to the shape rather than trusted: a
            // malformed tally would draw a count the host is not keeping.
            const window = readWindow(data?.window);
            // Stamped here, on this machine's clock, from the time the host said was left —
            // the same rule `until` already follows, for the same reason.
            const left = data?.clock ? deadlineIn(data.clock.remainingMs) : null;
            const clock =
              data?.clock && typeof data.clock.of === "string" && left !== null
                ? { of: data.clock.of, deadline: left }
                : null;

            /**
             * The gates, and the local memory of having answered them.
             *
             * A press is forgotten the moment the host's copy either counts this seat or has moved
             * past the gate — so the button's "waiting" is only ever ahead of the tally by the
             * length of one round trip, and can never outlive the gate it was about. That outliving
             * is precisely the reported soft lock. A press for a gate the host has not opened yet
             * stays: it is in flight, and the host opens the gate when it lands.
             */
            const strings = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
            const gates: TableGate[] = Array.isArray(data?.gates)
              ? data.gates.flatMap((g: unknown) => {
                  const gate = g as Partial<TableGate> | null;
                  return gate && typeof gate.id === "string" ? [{ id: gate.id, pressed: strings(gate.pressed) }] : [];
                })
              : [];
            const wentOn = strings(data?.wentOn);
            const onStory = strings(data?.onStory);
            const self = get().selfId;
            // What the host believes of this seat's screen; the next look says it again if wrong.
            if (self) onStorySent = onStory.includes(self);
            const pressing = get().pressing.filter(
              (id) =>
                !wentOn.includes(id) &&
                !gates.some((g) => g.id === id && self !== null && g.pressed.includes(self)) &&
                // A Next turn only exists while the host offers it: gone from the list, it closed.
                (!isNextGate(id) || gates.some((g) => g.id === id))
            );
            set({
              enableAI: typeof data?.enableAI === "boolean" ? data.enableAI : AT_REST.enableAI,
              claims,
              permissions,
              liveTyping:
                typeof data?.liveTyping === "boolean" ? data.liveTyping : AT_REST.liveTyping,
              continuePolicy: CONTINUE_POLICY_ROWS.some((row) => row.id === data?.continuePolicy)
                ? data!.continuePolicy
                : AT_REST.continuePolicy,
              // Through the tables, so a host running a build with an answer this one has never
              // heard of lands on the shipped default rather than a string nothing reads.
              noteVisibility: NOTE_VISIBILITY_ROWS.some((row) => row.id === data?.noteVisibility)
                ? data!.noteVisibility
                : AT_REST.noteVisibility,
              noteSeal: NOTE_SEAL_ROWS.some((row) => row.id === data?.noteSeal)
                ? data!.noteSeal
                : AT_REST.noteSeal,
              window,
              clock,
              gates,
              wentOn,
              paused: data?.paused === true,
              reader: typeof data?.reader === "string" ? data.reader : null,
              onStory,
              pressing,
            });
          }
          if (event.intent.kind === TYPING_KIND) {
            const data = event.intent.data as Partial<TypingPayload> | undefined;
            // One writer for `typing`, whichever of the three the payload carries: a stop
            // and a start are two values of one field, never two mechanisms.
            const at = data?.at === "story" || data?.at === "ooc" ? data.at : null;
            if (!at) {
              get().clearTyping(event.from);
              break;
            }
            set({
              typing: {
                ...get().typing,
                [event.from]: {
                  at,
                  until: Date.now() + TYPING_TTL_MS,
                  ...(typeof data?.preview === "string"
                    ? { preview: data.preview.slice(0, TYPING_PREVIEW_MAX_CHARS) }
                    : {}),
                },
              },
            });
          }
          if (event.intent.kind === FLOOR_REQUEST_KIND && get().isHost) {
            const data = event.intent.data as Partial<FloorRequestPayload> | undefined;
            if (data?.act === "ready") hostApplyFloorRequest(event.from, { act: "ready" });
          }
          if (event.intent.kind === CLAIM_KIND && get().isHost) {
            const data = event.intent.data as Partial<ClaimPayload> | undefined;
            get().assignClaim(
              event.from,
              typeof data?.characterId === "string" ? data.characterId : null
            );
          }
          if (event.intent.kind === RESYNC_REQUEST_KIND && get().isHost) {
            // The table half of the answer. The story half is `story-sync.ts`'s, off the same
            // relay — one question, one door each side of it.
            assertTable(event.from);
          }
          if (event.intent.kind === SEAT_VIEW_KIND && get().isHost) {
            // Only a seat's own screen, and only a seat at the table: `from` is stamped by the server.
            const data = event.intent.data as Partial<SeatViewPayload> | undefined;
            if (typeof data?.onStory === "boolean" && get().roster.some((p) => p.id === event.from)) {
              const others = get().onStory.filter((id) => id !== event.from);
              set({ onStory: data.onStory ? [...others, event.from] : others });
              // Named again from the host's own screen as it stands — the watcher's next look would,
              // but a guest arriving at the story should not wait for an unrelated move.
              get().syncReader(showsStory());
            }
          }
          if (event.intent.kind === GATE_PRESS_KIND && get().isHost) {
            // A guest is ready, at the gates they name — or asks the table to hold. A press for a
            // wait the table has already walked through changes nothing (`hostApplyPress`). The
            // gates themselves travel the other way as part of `table_state`, so this kind is one
            // direction only.
            const data = event.intent.data as Partial<GatePressPayload> | undefined;
            if (data?.pause === true) {
              if (get().roster.some((p) => p.id === event.from)) writeGates({ ...gateDraft(), paused: true });
            } else if (Array.isArray(data?.gates)) {
              hostApplyPress(
                event.from,
                data.gates.filter((x): x is string => typeof x === "string" && x.length > 0)
              );
            }
          }
          if (event.intent.kind === OOC_KIND) {
            const data = event.intent.data as Partial<OocPayload> | undefined;
            const text = typeof data?.text === "string" ? data.text.trim() : "";
            const images = oocImagesOf(data);
            if (!text && images.length === 0) break;
            appendOoc(
              {
                id: crypto.randomUUID(),
                from: event.from,
                // Resolved now, not at render: the name should survive its author leaving.
                name: get().roster.find((p) => p.id === event.from)?.name ?? "Someone",
                text,
                ...(images.length > 0 ? { images } : {}),
                at: Date.now(),
              },
              { unread: true }
            );
            // Their line landed *here* — the "typing…" it announced is done, TTL or not.
            get().clearTyping(event.from);
          }
          break;
        }
        case "join_refused":
          set({ ...atRest(), phase: "ended", endedReason: event.reason });
          break;
        case "room_closed":
          set({ ...atRest(), phase: "ended", endedReason: event.reason });
          break;
        /**
         * The two endings that spend this device's seat, so the token goes with them.
         *
         * `rememberSeat(..., "")` — the "leaving is not a reload" half of `seat-store` — had
         * no caller at all, so a token outlived every ending. That is right for the ones a
         * reload should survive and wrong for these: a kicked player's tab held a seat for a
         * table it had been removed from, and a replaced one held a seat another device is
         * now sitting in. Both would be re-offered on the next join of the same code, asking
         * the server to honour a chair that is not theirs.
         *
         * A deliberate leave keeps its token on purpose. Identity at a table *is* the seat —
         * it is what `playerCharacterId` builds a cast member from — so forgetting it there
         * would bring somebody back as a stranger beside their own abandoned card.
         */
        case "replaced":
          rememberSeat(get().hostAddress, get().code ?? "", "");
          set({ ...atRest(), phase: "ended", endedReason: "replaced" });
          break;
        case "kicked":
          rememberSeat(get().hostAddress, get().code ?? "", "");
          set({ ...atRest(), phase: "ended", endedReason: "kicked" });
          break;
      }
  }
});

/**
 * The third door back into a frozen tab.
 *
 * A hidden tab's `setTimeout` is clamped and, once the tab is discarded from the foreground,
 * may not fire at all — so the host coming back to a table it had stopped running is the
 * moment the deadline has to be re-read rather than waited for. Registered when the plugin
 * loads (`plugins/multiplayer/client/client.ts`), guarded for the server render.
 */
export function watchExpiryOnReturn(): () => void {
  if (typeof document === "undefined") return () => {};
  const onVisible = () => {
    if (document.visibilityState === "visible") useRoomStore.getState().checkExpiry();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

/**
 * **The table a guest's tab is sitting at, kept for its reload** — `plugins/multiplayer/client/sitting.ts`.
 *
 * Derived from the store rather than written at each door: a guest's hello seats the tab, and
 * every way a sitting ends (Leave, a kick, the room closing, a refusal, being replaced) passes
 * through `idle` or `ended`, so no door can forget to stand up. A reload changes neither — the
 * page is gone before anything moves here — which is the whole of why it is remembered.
 */
export function keepSitting(): () => void {
  return useRoomStore.subscribe((s, prev) => {
    if (s.phase === prev.phase && s.isHost === prev.isHost && s.code === prev.code) return;
    if (s.phase === "lobby" && !s.isHost && s.code) sitDown({ code: s.code, host: s.hostAddress });
    else if (s.phase === "idle" || s.phase === "ended") standUp();
  });
}

/**
 * **The chat a hosted table is bound to stays whole on this device** (`lib/chat/kept-open.ts`): the
 * host's tab answers every guest from it — the snapshot, the turns, the floor — whether or not it is
 * the chat on the host's screen. A guest's bound chat is the host's record, not this library's.
 */
export function chatsHostedHere(state: Pick<RoomStore, "isHost" | "boundChatId">): string[] {
  return state.isHost && state.boundChatId ? [state.boundChatId] : [];
}

/** The held set's provider for the hosted chat — registered on load, released on unload. */
export function holdHostedChat(): () => void {
  return keepChatsOpenFrom(useRoomStore, chatsHostedHere);
}

/** A reloaded guest's tab sits back down where it was, with the seat it already holds. */
export async function resumeSitting(): Promise<void> {
  const sitting = sittingAt();
  if (!sitting || useRoomStore.getState().phase !== "idle") return;
  await useRoomStore.getState().joinRoom(sitting.code, sitting.host);
}

