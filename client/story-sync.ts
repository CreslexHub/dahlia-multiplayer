import {
  observeRoomEvents,
  RESYNC_REQUEST_KIND,
  readGateId,
  showsStory,
  tableFloorFor,
  toHost,
  useRoomStore,
} from "./roomStore";
import { clearGuestChat, isGuestChatId, setGuestChat } from "./guest-session";
import { noteTableReading, tableReadingOf } from "./table-reading";
import { guestMayActOnMessage } from "./permissions";
import { chatForGuest } from "./guest-copy";
import { GUEST_CARD_FIELDS, HOST_KEEPS, MAX_GUEST_CARD_NAME, readGuestCrop, readGuestPicture, readGuestText, readOrRefusal } from "./guest-cards";
import { guestActionEdit, guestBundleEdits } from "./guest-proposal-edits";
import { type RoomIntent } from "../shared/protocol";
import {
  firstRevision,
  follows,
  isNewer,
  isStale,
  nextRevision,
  readRevision,
  type Revision,
} from "./revision";
import { initContinueGate } from "./continue-gate";
import { app } from "@dahlia/plugin-api";
import type { PublishedReveal, RunStatePayload, LibraryEditPayload, ProposalActionPayload, ProposalIntentAction, ReadingMark, ChatState, AnswerEdit, TurnCursor, MessageAction, ArmedAction, Chat, Character, ChatFolder, Message, MessageFile, MessageImage, NoteDirection, AttachmentLimits } from "@dahlia/plugin-api";

const { isInlinePicture, attachmentLimits } = app.cards;
const { isOthersPlayerCard, playerCharacterId, claimedCharacterFor, personaCharacterOf, isReservedCardId, mayDeleteCharacter, mayLeaveStory } = app.cast;
const { playerName } = app.identity;
const { deleteCharacter, deleteChatFolders, deleteWorld, setEntityInChat, upsertCharacter, upsertChatFolders, upsertWorld, absorbCard } = app.library;
const { maySpeakNow, playerSeat, ownerOfSpeaker, tableFor } = app.mic;
const { APPROVE_REFUSED, approve: applyProposalBundle, deny: denyProposalAction, reject: rejectProposalBundle, restoreAction: restoreProposalAction, restore: restoreProposalBundle, update: updateProposalAction, isPending: isPendingBundle } = app.proposals;
const { applyRunStateToChat, currentRun, readReveal, readRun, placeReadingMark, readingMarkOf, readReadingMark, fitTo: fitRevealTo, publishedOf: publishedRevealOf, reset: resetReveal } = app.reveal;
const { PIPELINE_AT_REST, pipelineFor, mutateChat, readChat, quietly, normalizeChat, onChatsChanged, tableTurnsOf } = app.story;
const { handOverTurn, holdTurn, stampRoundEntry, applyTurnDelete, applyTurnEdit, messageForTurnId, mayRestructure, restructureChat, returnCarriedTakes, editAnswer, parseChunkTurnId, stopTurn, cursorAtEndOfMessage, cursorAtOrBefore, divergingTurnIndex, interruptWithLine, markInterruptedBy, revealPacesTurns, holdsForReader, resolveAnimation, clampLifetime, tuning, playerLineWords, readPlayerLineTools, queueInjection, applyArmedActions } = app.turns;

/**
 * Everyone reads the same story.
 *
 * The host's tab owns the `Chat` and is its only writer (MULTIPLAYER.md §2.1); guests
 * hold the view `guest-session.ts` describes. This module is the traffic between the
 * two:
 *
 *  - `story_snapshot`  host → guest. The whole chat: at each join (targeted), when the
 *    host reconnects, and whenever the transcript changes in a way that is not a pure
 *    append (an edit, a swipe, a delete — re-sending the truth beats mirroring every
 *    mutation kind and drifting on the first one nobody mirrored).
 *  - `story_append`    host → everyone. One committed message. The common case, found by
 *    *diffing* the host's chat after each store change rather than by hooking the commit
 *    sites — there are many ways a message lands (typed, generated, split into pseudo
 *    chunks) and a hook per site is a list that goes stale.
 *  - `story_chunk`     host → everyone. The narration *in flight*. The live text never
 *    touches `chat.messages` on the host — it lives in the pipeline slice and the
 *    transcript overlays it — so the append diff cannot see it, and without this relay
 *    a guest watched nothing until the commit landed all at once. The mirror writes the
 *    same pipeline slice on the guest, so the identical render path (live bubble,
 *    reveal, typing indicator) lights up with no second implementation.
 *  - `player_message`  guest → host. "I said this." Only the host acts on it: the line
 *    is committed through the same mutation path the host's own composer uses, which
 *    re-enters the diff above and broadcasts the append — so every tab, the speaker's
 *    included, receives the message in the order the chat actually took it.
 *
 * A guest speaks as a real `Character` on the chat (`roleSetting: "user"`), minted by
 * the host on first message with a stable id derived from the account. That is what
 * lets the transcript, the portraits and the speaker system treat a friend exactly like
 * every other named speaker instead of growing a parallel "remote player" rendering
 * path — and it is the seed the claim/impersonation rules formalise.
 */

export const STORY_SNAPSHOT_KIND = "story_snapshot";
export const STORY_APPEND_KIND = "story_append";
/**
 * **The turn in flight** — one kind where there were two (`story_chunk` and `story_status`).
 *
 * See `RELAYED_PIPELINE_FIELDS` for what it carries and why it is a declared list rather than a
 * handful of fields somebody chose.
 */
export const RUN_STATE_KIND = "run_state";
export const PLAYER_MESSAGE_KIND = "player_message";
export const PLAYER_CARD_KIND = "player_card";
export const MESSAGE_ACTION_KIND = "message_action";
export const PROPOSAL_ACTION_KIND = "proposal_action";
export const LIBRARY_EDIT_KIND = "library_edit";
export const DIRECTOR_NOTE_KIND = "director_note";
export const STOP_GENERATION_KIND = "stop_generation";
/**
 * Guest → host: the reveal of the guest the host named the table's reader (`reader` in
 * `roomStore`), so the host can relay it to every other seat in the run's frames — the way its own
 * is relayed while it reads. Taken only from that seat: anything else is a guest steering the table
 * by publishing, and is ignored.
 */
export const TABLE_READING_KIND = "table_reading";
type TableReadingPayload = { reveal: PublishedReveal | null };
/**
 * What this tab holds, for the resync door — `RESYNC_REQUEST_KIND` lives in `roomStore`, which
 * answers the table half of the same question. Asked on three occasions, all of them "I might
 * be behind and have no way to know": a re-seat's `hello`, the wire coming back after a drop,
 * and an append that does not follow what this tab holds.
 */
type ResyncRequestPayload = { storyRev: Revision | null };

export type StopGenerationPayload = {
  /** What the guest had read, when Stop is to discard the rest — see `ReadingMark`. */
  mark?: ReadingMark;
};

/** Edits arrive in bursts (a swipe re-writes a message several times); send the truth once. */
const RESNAPSHOT_DEBOUNCE_MS = 400;
/**
 * ...but a debounce with no ceiling is a debounce that can be starved. A turn's agents write
 * their logs onto the message they just read, one after another, and every write pushed the
 * snapshot back another 400 ms — so the room could wait out a whole pass for a change it had
 * already been promised. After this long the truth goes regardless.
 */
const RESNAPSHOT_MAX_WAIT_MS = 1_200;

/**
 * How often the narration in flight goes out. Tokens arrive far faster than a POST per
 * token could survive the tunnel; each send carries the whole text so far, so a lost one
 * costs nothing but smoothness — the next covers it.
 */
export const STREAM_RELAY_MS = 150;

/**
 * The whole truth, and which generation of it this is.
 *
 * `rev` is what makes a snapshot an *answer* rather than a hope: the guest stamps it and every
 * append after it says which revision it follows, so a missing one is a thing either side can
 * name. See `plugins/multiplayer/client/revision.ts`.
 *
 * **`run` is the turn in flight at the moment the truth was taken**, and it rides *with* the
 * story because a snapshot is how a reader catches up — a join, a resync, a re-seat, the host
 * coming back — and catching up on the transcript alone left the rest of the screen where it
 * was. A phone that slept through the end of a reply woke to a snapshot holding the reply and a
 * pipeline still saying `isGenerating`: a Stop button, a typing indicator and a live bubble for
 * a turn that was over, until somebody started another. A reader who sat down during a
 * between-voices pause had no clock to count. The run's own relay could not cover either: it
 * only speaks when the host's slice *moves*, and at the end of a reply it has stopped moving.
 */
type StorySnapshotPayload = { chat: Chat; rev: Revision; run?: RunStatePayload };
/**
 * One committed message, and the revision it follows.
 *
 * `base` is the load-bearing half. Without it a lost append left a hole that **neither side
 * could see** — the host had already advanced its own baseline before sending, so nothing was
 * ever re-offered, and the guest's transcript was quietly missing a line of the story with
 * every screen agreeing that all was well.
 */
type StoryAppendPayload = { message: Message; base: Revision; rev: Revision };
/**
 * `mark` is where the *sender's* reading had got to when they spoke — see `ReadingMark`.
 * Absent means "after everything", which is a plain append.
 */
type PlayerMessagePayload = {
  text: string;
  mark?: ReadingMark;
  typing?: boolean;
  /** The sender's own name for this send, echoed back if it is refused. */
  id?: string;
  /**
   * What the sender armed in the state drawer, spent on this turn.
   *
   * It rides the message because that is what it is anchored to: the host applies it against
   * the line it commits, so rewinding past that turn takes the torch back out with it. A
   * guest's queue used to be spent by nothing at all — the guest send path returns before
   * `spendArmedActions`, so the chips sat over the composer, nothing happened, and no screen
   * said why.
   */
  armed?: ArmedAction[];
  /**
   * The pictures sent with the line — the same inline data URLs a portrait crosses as. The
   * host files them on the message it commits and describes them there, because the host's
   * tab is the one with a server to ask; the guest sees the sentence come back in the next
   * snapshot, under the picture, the way the host does.
   */
  images?: MessageImage[];
  /** The documents sent with the line, as the text the guest's browser read them to. */
  files?: MessageFile[];
};
/**
 * **What "dressing" means, as one list.**
 *
 * The `player_card` door carries these and nothing else: they are how somebody *looks* at
 * the table, which is their identity and never a permission. Everything else on a minted
 * card — its states, and therefore every link written on it — is story content, and story
 * content goes through the `library_edit` door where the `editLibrary` right answers.
 *
 * The list is here rather than written out at the four places that need it, because those
 * read it from opposite directions: the guest splits its save by it, the host strips it off
 * another player's record, `PlayerCardPayload` *is* it, and `applyPlayerCard` picks by it. A
 * fifth field on the payload that this forgot would be a field the guest could never send.
 */
const PLAYER_CARD_FIELDS = ["name", "description", "image", "imageTransform"] as const;
type PlayerCardField = (typeof PLAYER_CARD_FIELDS)[number];

/**
 * A guest's own character card, brought to the table. Applied onto their minted
 * `playerCharacterId` character — the id stays theirs, the face and description are the
 * card's — so their portrait travels in the next snapshot like any cast member's. The
 * image is the same inline data URL every stored portrait already is.
 *
 * It is the list above rather than a shape of its own, because a shape of its own is how a
 * `states?: EntityState[]` got onto an ungated door: the field was added to the payload and
 * read by the host nine days after the split that says states are not dressing, and no
 * reader of either half could see the other.
 */
type PlayerCardPayload = Pick<Character, PlayerCardField>;

const isDressing = (key: string): boolean =>
  (PLAYER_CARD_FIELDS as readonly string[]).includes(key);
/** A guest's edit or delete, addressed by turn id — a message or one chunk of one. */
type MessageActionPayload = {
  action: MessageAction;
  turnId: string;
  /** The replacement text, for `edit`. */
  content?: string;
  /** The pictures as they should stand after an `edit`; absent leaves them as they are. */
  images?: MessageImage[];
  /**
   * The documents as they should stand after an `edit`, absent leaving them as they are. Read
   * as a list of ids to keep: an edit can take a file off a line and has no way to add one, so
   * the host keeps its own copy of each it already holds and nothing a guest sent along.
   */
  files?: MessageFile[];
  /**
   * The words of the addressed message as this guest held them — sent for a *chunk* id.
   *
   * A chunk id is `messageId` plus a position among that message's bubbles, and the position is
   * the guest's: counted in their copy of the message. If the host's copy has been rewritten
   * since (an edit, a cut, a line taken out), "bubble 2" is somebody else's line there, and the
   * edit or delete landed on it. A whole-message id is an identity and needs nothing more.
   */
  base?: string;
  /**
   * **An answered tool on the message, changed** — its call or its answer, as text, standing at
   * `atOffset` in the message's raw (`lib/chat/answer-edits.ts`). An `edit` of the message, so the
   * guest's right to edit the line is the whole of the question; addressed by the message's own
   * id, since an answer belongs to the message and not to a bubble of it.
   */
  answer?: { atOffset: number; edit: AnswerEdit };
};

/** An answer edit a guest sent, kept by shape only — the numbers are checked again where it lands. */
function guestAnswerEdit(raw: unknown): { atOffset: number; edit: AnswerEdit } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { atOffset, edit } = raw as { atOffset?: unknown; edit?: Record<string, unknown> };
  if (typeof atOffset !== "number" || !edit || typeof edit !== "object" || typeof edit.result !== "string") return undefined;
  if (edit.call !== undefined && typeof edit.call !== "string") return undefined;
  // Two texts, read by the host's own parsers where the edit lands (`editedAnswer`).
  return { atOffset, edit: { ...(typeof edit.call === "string" ? { call: edit.call } : {}), result: edit.result } };
}

/**
 * The pictures a guest sent, kept by shape only and capped where the composer caps — the bound
 * chat's own limit (Settings → Advanced): a picture is an id and an inline image, and anything else
 * in the slot is not one. The description is the host's to write, so one sent along is dropped
 * rather than trusted — an edit that keeps a picture keeps the host's own sentence for it
 * (`applyMessageAction`).
 */
function guestPictures(raw: unknown, limits: AttachmentLimits): MessageImage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (i): i is MessageImage =>
        !!i && typeof i === "object" && typeof i.id === "string" && isInlinePicture(i.dataUrl)
    )
    .slice(0, limits.maxPictures)
    .map((i) => ({ id: i.id, dataUrl: i.dataUrl }));
}

/**
 * The documents a guest sent, kept by shape and capped where the composer caps — the count and
 * each text's length — so a crafted intent cannot hand the host's library a line the host's own
 * composer would have refused.
 */
function guestFiles(raw: unknown, limits: AttachmentLimits): MessageFile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (f): f is MessageFile =>
        !!f &&
        typeof f === "object" &&
        typeof f.id === "string" &&
        typeof f.name === "string" &&
        typeof f.mime === "string" &&
        typeof f.size === "number" &&
        typeof f.text === "string" &&
        f.text.length <= limits.maxFileChars
    )
    .slice(0, limits.maxFiles)
    .map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, text: f.text }));
}
/**
 * Everything a Director pane does to a proposal record. Approve and reject were the
 * whole list, so a guest's edit and a guest's per-action decline had nowhere to go and
 * were written straight into their own view — where the host never saw them and the
 * next snapshot took them back. An edited "Gold = 50" was approved as the Director's
 * original 5, and a declined action of an approved bundle applied anyway.
 */
/**
 * **The host answering "no".**
 *
 * The up-link now retries (`lib/net/outbox.ts`), so "it did not arrive" is a thing that
 * happens once the outbox has given up rather than on the first failed POST. What retrying
 * cannot cover is the other two ways a send is lost with *positive* feedback: a permission
 * revoked while the words were in flight, and a turn rule the sender's screen had not caught
 * up with. For both of those the host heard it perfectly well and said no.
 *
 * This is an ack, not a retry queue — the retry is a layer below. The host says which intent
 * and why; the sender puts the words back in the box and reads the sentence.
 */
export const INTENT_REFUSED_KIND = "intent_refused";
export type IntentRefusedPayload = {
  /** The kind that was refused, so a reader can be told what did not happen. */
  of: string;
  /** A sentence for the person holding the keyboard. */
  reason: string;
  /** Names the sender's own outbox entry, when the intent carried words to restore. */
  id?: string;
};

const PROPOSAL_INTENT_ACTIONS = ["approve", "reject", "edit", "deny", "restore"] as const satisfies readonly ProposalIntentAction[];
/** Intake's reader of that list, so the wire cannot come to know a sixth verdict. */
function isProposalIntentAction(value: unknown): value is ProposalIntentAction {
  return typeof value === "string" && (PROPOSAL_INTENT_ACTIONS as readonly string[]).includes(value);
}
/**
 * A guest's Director note: what it says, who it is for, how long it lasts.
 *
 * **Not who wrote it.** That is `from`, stamped by the server on every relay, so a note
 * cannot be filed under somebody else's name from a guest's keyboard — the same reason the
 * player's own card is keyed off `from` rather than off anything in the payload.
 */
/** The note, plus the sender's own name for the send — echoed back if it is refused. */
type DirectorNotePayload = NoteDirection & { id?: string };

/**
 * **Which generation of the story the host has broadcast.**
 *
 * Minted when the host first asserts a chat and stepped on every send, so a snapshot and the
 * appends that follow it form a chain a guest can check. Module state beside the diffing
 * baselines because it is the same fact from the other side: `syncedMessages` is *what* was
 * last said, this is *when*.
 */
let storyRev: Revision | null = null;

/** What the host most recently broadcast, to diff the next store change against. */
let syncedMessages: Message[] | null = null;
/**
 * **The rest of the chat as last broadcast** — everything a snapshot carries that an append
 * does not, as *one* baseline.
 *
 * It was three (`syncedCharacters`, `syncedWorlds`, `syncedSettings`), each compared by array
 * identity against the live chat, under a comment claiming *"`cloneChatForMutation` is
 * shallow-per-collection, so an untouched roster is the same array"*. That is not what the clone
 * does: it copies **every** collection on every mutation, because it has to — a write must not
 * land on an earlier generation. So the check answered "yes, the roster moved" to every single
 * store write, and two opposite faults followed from the one sentence:
 *
 *  - **the whole story went out again for every appended line.** A debounced full-chat snapshot
 *    per guest, per line, for the life of the session — the `story_append` path exists precisely
 *    to avoid that, and nothing was using it.
 *  - **and the three collections were the wrong three anyway.** `characterIds`, `worldIds`,
 *    `proposalBundles`, `storyArcs`, `summaries`, `hiddenInjections` — a change to any of those
 *    alone moved none of the three, and reached a guest only because the check was broken in the
 *    other direction. Narrowing the reference test without widening the list would have turned a
 *    false positive into a silent false negative: a card switched off, or a Director's bundle
 *    landing between messages, seen by nobody.
 *
 * So it is one question — *has anything but the messages moved?* — asked of the whole record, so
 * that a field added to `Chat` is covered by having been added.
 */
let syncedRest: string | null = null;
/**
 * And under which answer to "who may read a note", because that decides what each guest was
 * *given* — not what the chat says. Nothing about the chat changes when the host closes the
 * notes to the table, so no diff below would ever notice, and the sealed cards on a guest's
 * screen would stay sealed until something else happened to move.
 */
let syncedNotePolicy = "";
let resnapshotTimer: ReturnType<typeof setTimeout> | null = null;
/** When the debounce currently in flight stops being allowed to slide — see the constant. */
let resnapshotDeadline = 0;
/**
 * The turn in flight as last mirrored out, and the throttle that paces it.
 *
 * `relayedRun` is the *serialised* last picture, compared before sending: the pipeline slice
 * moves for reasons a guest cannot see (a pass stamping, a field this build withholds), and a
 * frame per store write would spend the tunnel saying nothing. Three variables replace five,
 * and with them goes the hand-ordering the two old kinds needed at each call site.
 */
let runTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRun: RunStatePayload | null = null;
let relayedRun = "";
/** Guests' lines commit one at a time — two arriving together must not interleave the
 *  interrupt-then-append dance and land in an order neither tab saw. */
let commitQueue: Promise<void> = Promise.resolve();
/**
 * The generation of the story *this* tab holds, as a guest — the other end of `storyRev`.
 *
 * Null means "nothing, or nothing I can place", which is itself an answer: it is what a resync
 * request carries, and it is why a guest that has just re-seated asks rather than assuming.
 */
let heldRev: Revision | null = null;
let wired = false;

function room() {
  return useRoomStore.getState();
}

/**
 * Tell one guest their intent did not land, and why.
 *
 * Addressed rather than broadcast: a refusal is between the host and the person who
 * asked. It is fire-and-forget in the same way every other intent is — a refusal that
 * itself fails to arrive leaves the sender no worse off than before there was one.
 *
 * **`id` means "the words did not land — hand them back"**, because that is what the sender
 * does with it: the composer puts the text named by that id back in the box. So it is passed
 * only by a refusal that stopped the whole send, never by one that refused half of a send
 * that went in — that put a line already in the story back in the composer, and the next
 * press of Enter said it twice.
 */
function refuse(to: string, of: string, reason: string, id?: string): void {
  void room().wire?.event(
    { kind: INTENT_REFUSED_KIND, data: { of, reason, ...(id ? { id } : {}) } satisfies IntentRefusedPayload },
    to
  );
}

/**
 * The one answer for every door a guest knocks on while the host is not in a story.
 *
 * It was written out at each of them, and a fourth was about to be typed. One sentence in
 * one place, because what a table hears when the host wanders off is a single fact.
 */
const NO_STORY = "The host is not in a story right now.";

/** A seat with a wire and no host at the other end of it — see `toHost`. */
const HOST_AWAY = "The host has stepped away from the table — send it again when they are back.";

/**
 * What this tab has said that the host has not answered for.
 *
 * Only the words are kept, and only so a refusal can put them back in the composer. It is
 * a ring rather than a queue: nothing acknowledges a *successful* send — the line comes
 * back in the story, which is the acknowledgement — so entries are evicted by age, and
 * the bound is what stops a long session from remembering everything anybody ever typed.
 */
const outbox = new Map<string, { of: string; text: string; chatId: string | null }>();
const OUTBOX_MAX = 16;

/**
 * With the story the words were typed in: a refusal can arrive after the reader has opened
 * another chat, and the words went into whichever composer was on screen — a line meant for the
 * table sitting in a solo story's box, one Enter from being sent there.
 */
function remember(id: string, of: string, text: string): void {
  outbox.set(id, { of, text, chatId: room().boundChatId });
  while (outbox.size > OUTBOX_MAX) {
    const oldest = outbox.keys().next().value;
    if (oldest === undefined) break;
    outbox.delete(oldest);
  }
}

/** Say a send did not land — from the host's answer, or from the POST never arriving. */
function announceRefusal(of: string, reason: string, id?: string): void {
  const held = id ? outbox.get(id) : undefined;
  if (id) outbox.delete(id);
  app.story.refused(held ? { of, reason, text: held.text, chatId: held.chatId } : { of, reason });
}

/**
 * Send something the reader typed, and notice when it does not arrive.
 *
 * `event` keeps trying and resolves `false` only when the outbox gives up on it — the room
 * closing under it, or a backlog so deep the table is plainly unreachable. So the sentence
 * this shows is now about a session that has ended rather than about one bad second of wire,
 * which is what makes it worth showing: the version before the retry existed cried wolf at
 * every hiccup, and the words were still perfectly deliverable.
 */
function sendTyped(intent: RoomIntent, of: string, id: string, text: string): void {
  remember(id, of, text);
  const host = toHost();
  if (!host) {
    announceRefusal(of, room().wire ? HOST_AWAY : "You are not at a table any more.", id);
    return;
  }
  void host.event(intent).then((ok) => {
    if (!ok) announceRefusal(of, "That never reached the table — check your connection.", id);
  });
}

function hostingChat(): Chat | null {
  const { phase, isHost, boundChatId } = room();
  if (phase !== "lobby" || !isHost || !boundChatId) return null;
  return readChat(boundChatId) ?? null;
}

// ─── Host: keep the room fed ─────────────────────────────────────────────────────────────

/**
 * The story as one guest is allowed to receive it.
 *
 * The only difference between two recipients' copies, and the reason a broadcast became a
 * send each: a Director's note is *hidden*, and it was hidden from the story and from nobody
 * else — the host's private steering rode this to every screen in the room.
 *
 * Redacted **here**, where the snapshot leaves the host, rather than filtered on the screen
 * that draws it. A note stripped by the drawing is a note anybody can read out of the
 * console, and "sealed" would be a promise the wire breaks. What is taken out, and from where,
 * is `chatForGuest`'s — every copy of the words, not the one field that was their home.
 */
export function storyFor(chat: Chat, ownerId: string): Chat {
  const { claims, noteVisibility, noteSeal } = room();
  return chatForGuest(chat, { ownerId, claims, visibility: noteVisibility, seal: noteSeal });
}

/**
 * A send per recipient, not one broadcast.
 *
 * Because the copies genuinely differ now — see `storyFor`. It costs the roster's worth of
 * sends where it used to cost one, which a table of at most `MAX_ROOM_PLAYERS` and a
 * debounced snapshot can carry; if it ever stops being carryable, the move is to take the
 * notes *out* of the snapshot and give them a per-guest message of their own, rather than to
 * redact somewhere a reader can undo it.
 */
function sendSnapshot(to?: string): void {
  const chat = hostingChat();
  if (!chat) return;
  // Whatever a debounce was waiting to say, this says more: the snapshot *is* the truth, so a
  // timer left running would send the same chat again a moment later. Only for a broadcast —
  // a snapshot aimed at one joiner tells the rest of the room nothing, so their pending one
  // still has to go.
  if (to === undefined) cancelResnapshot();
  syncedMessages = chat.messages;
  syncedRest = restOfChat(chat);
  syncedNotePolicy = notePolicyKey();
  const { wire, roster, selfId } = room();
  if (!wire) return;
  /**
   * **The chain numbers the story, not the sends.**
   *
   * A broadcast snapshot is the story moving on, so it steps. A *targeted* one — a joiner, a
   * resync — is one reader catching up with a story that has not moved, so it carries the
   * generation that already stands.
   *
   * Stepping for a targeted send is `.agents/SYNC.md` §11.1, and it was this round's own
   * regression: the argument for it read *"the room's generation is one number, not one per
   * reader"*, which is true and is the reason **not** to step — the number it stepped was one
   * per *send*, and a send to one reader left every other guest holding a generation the next
   * append no longer claimed to follow. Each of them then asked for a resync, each answer
   * stepped it again onto one reader, and the chains never re-converged: with two guests, every
   * line of the story cost a full-chat snapshot to all but one of them, indefinitely.
   */
  const rev = to === undefined ? step() : storyRev ?? step();
  const targets = to !== undefined ? [to] : roster.filter((p) => p.id !== selfId).map((p) => p.id);
  const run = tableRun(app.story.chats.get(), chat.id);
  for (const id of targets) {
    wire.state(
      { kind: STORY_SNAPSHOT_KIND, data: { chat: storyFor(chat, id), rev, run } satisfies StorySnapshotPayload },
      id
    );
  }
}

/** The host's next generation of the story — minting the chain if this is its first word. */
function step(): Revision {
  storyRev = storyRev ? nextRevision(storyRev) : firstRevision();
  return storyRev;
}

/** The two answers that decide what a guest may hold, as one value to compare against. */
function notePolicyKey(): string {
  const { noteVisibility, noteSeal } = room();
  return `${noteVisibility}/${noteSeal}`;
}

function cancelResnapshot(): void {
  if (resnapshotTimer) clearTimeout(resnapshotTimer);
  resnapshotTimer = null;
  resnapshotDeadline = 0;
}

function scheduleResnapshot(): void {
  const now = Date.now();
  if (resnapshotTimer) clearTimeout(resnapshotTimer);
  else resnapshotDeadline = now + RESNAPSHOT_MAX_WAIT_MS;
  const wait = Math.max(0, Math.min(RESNAPSHOT_DEBOUNCE_MS, resnapshotDeadline - now));
  resnapshotTimer = setTimeout(() => {
    resnapshotTimer = null;
    resnapshotDeadline = 0;
    sendSnapshot();
  }, wait);
}

/**
 * The host's transcript changed — decide what the room needs to hear. A pure append
 * (the old list is a prefix of the new) travels as `story_append`s; anything else —
 * same ids with different content, ids gone, order changed — travels as the whole
 * truth, debounced.
 */
/**
 * Broadcast whatever the *hosted* chat now says, whichever chat is on screen.
 *
 * The one door, so that the two triggers below cannot come to disagree about which chat the
 * room is being told about. It reads `hostingChat()` — the bound id, through storage — rather
 * than the store's `activeChat`, which is a different question with the same shape.
 */
function broadcastHostedChat(): void {
  const chat = hostingChat();
  if (chat) broadcastChatChange(chat);
}

/**
 * Everything a snapshot carries but an append does not, as one string.
 *
 * **Why a serialisation and not a reference walk.** A reference walk is what was here, and it
 * cannot be trusted in either direction. Upwards, `cloneChatForMutation` replaces every array on
 * every mutation, so comparing the arrays answers "changed" to everything. Downwards — and this
 * is the half that decided it — writers on this very path mutate a card **in place**
 * (`applyPlayerCard` did, and `.agents/AGENTS.md` §1 records that it is not the only one), so
 * comparing the *elements* would answer "unchanged" to a portrait that had just been replaced.
 * The failure is silent and one-sided: the guest never hears, and nothing on either screen says
 * so. That is the exact bug class this whole round exists to end, so the check may not be the one
 * that depends on thirty writers behaving.
 *
 * Three keys are left out, each because it is not content the guest can see:
 *
 *  - **`messages`** — the append path owns it, and skipping it is the whole point: a line that
 *    was appended must not also re-send the story.
 *  - **`updatedAt`** — a stamp saying *when*, rewritten by `upsertChat` on every single write.
 *    Including it would make every mutation "a change to the rest of the chat", which is the
 *    fault this replaces.
 *  - **`touchedAt`** — the home list's stamp, and the same fault on a second clock: the open
 *    chat's edits stamp it, streamed tokens included, so it would re-send the chat per token.
 *
 * **The cost, measured** rather than assumed: ~0.3 ms for an ordinary chat and ~1.9 ms for a
 * deliberately awful one (eight cards carrying 120 KB portraits each, a megabyte in all), once
 * per *chat mutation* — not per token, because the subscription that calls this only fires when
 * `activeChat` itself moves. It replaces a debounced full-chat snapshot **per guest, per line**,
 * so it is strictly cheaper than what it is deciding not to do.
 */
const NOT_CONTENT: readonly (keyof Chat)[] = ["messages", "updatedAt", "touchedAt"];

/**
 * ...and one key *inside* the chat's pipeline record: **`passStamps`**, the host pipeline's own
 * bookkeeping of which pass has run against which anchor. Each stamp carries `Date.now()`, so
 * every pass of every turn was "a change to the rest of the chat" and re-sent the whole chat to
 * every guest — who runs no pipeline and draws nothing of it. `failedPasses` beside it is what
 * is compared: a guest draws the Continue / Retry box off it.
 */
function restOfChat(chat: Chat): string {
  const rest: Record<string, unknown> = { ...chat };
  for (const key of NOT_CONTENT) delete rest[key];
  // Compared by what a guest draws of it, so the record being minted by the first stamp is no
  // change either.
  rest.pipeline = chat.pipeline?.failedPasses;
  return JSON.stringify(rest);
}

function broadcastChatChange(chat: Chat): void {
  const previous = syncedMessages;
  const current = chat.messages;
  // The roster, the worlds, the settings and everything else travel only inside snapshots, so a
  // change to any of them — a claimed card's portrait, a guest's own card arriving, a card
  // switched off, a Director's bundle landing — needs the whole truth even when no message moved.
  // Serialised once per change: the comparison and the new baseline are the same string.
  const rest = restOfChat(chat);
  const restMoved = syncedRest !== null && rest !== syncedRest; // first sight — joiners get snapshots
  if (previous === current && !restMoved) return;
  syncedMessages = current;
  syncedRest = rest;
  if (previous === null) return; // first sight of the chat — joiners get snapshots
  // The rest of the chat rides the debounced snapshot; any appended lines still go out at once
  // below, so a first message that also minted its speaker is not held to the debounce.
  if (restMoved) scheduleResnapshot();
  if (previous === current) return;

  /**
   * Two different changes, and they were one.
   *
   * A turn removed, inserted or reordered — a retry, a swipe past the last take, a prune, a
   * guest's line going in mid-burst — moves what every *index* means. Guests are holding
   * bubbles that no longer exist and a reveal cursor pinned to positions that have shifted,
   * so this is not an edit to be batched with the next one: the truth goes at once.
   *
   * A turn whose *text* was rewritten in place is the ordinary case — an agent writing its
   * log onto the reply it just read — and it can wait for the debounce. What it may no longer
   * do is hold up an append that landed beside it: the old test compared message objects by
   * reference, so a log written onto turn 8 in the same breath as turn 9 arriving sent *no*
   * append at all and left the story to catch up 400 ms later, or longer if the writes kept
   * coming. Identity is the question — `divergingTurnIndex` is where it is asked.
   */
  if (divergingTurnIndex(previous, current) !== null) {
    sendSnapshot();
    return;
  }
  if (previous.some((m, i) => m !== current[i])) scheduleResnapshot();
  /**
   * An appended line is each guest's copy of it, as a snapshot is (`storyFor`): a line can carry
   * an agent's run with a notebook write in it as surely as a whole chat can. A guest's copy is the
   * host's own object when there was nothing in it to take out, so the ordinary line is still one
   * broadcast; only a line that differs for somebody goes out per guest.
   */
  const { wire, roster, selfId } = room();
  const copies = roster
    .filter((p) => p.id !== selfId)
    .map((p) => ({ id: p.id, messages: storyFor(chat, p.id).messages }));
  for (let at = previous.length; at < current.length; at++) {
    const message = current[at];
    // Each append names the revision it follows, so a guest that receives one out of the chain
    // knows a line went missing instead of quietly holding a transcript with a hole in it.
    const base = storyRev ?? firstRevision();
    if (!storyRev) storyRev = base;
    const rev = step();
    const append = (line: Message, to?: string) =>
      void wire?.event({ kind: STORY_APPEND_KIND, data: { message: line, base, rev } satisfies StoryAppendPayload }, to);
    if (copies.every((copy) => copy.messages[at] === message)) append(message);
    else for (const copy of copies) append(copy.messages[at], copy.id);
  }
}

/**
 * The pipeline slice moved — mirror the narration in flight out to the room.
 *
 * Watched off the store like the transcript diff above, and for the same reason: every
 * way a narration streams (a typed turn, live mode, a retry) writes this one slice, so
 * one subscription cannot miss a door. Throttled to `STREAM_RELAY_MS`; each send is the
 * whole text so far, so ordering inside the throttle window costs nothing.
 */
function relayPipelineChange(store: ChatState): void {
  const { phase, isHost, boundChatId } = room();
  if (phase !== "lobby" || !isHost || !boundChatId) return;
  queueRun(tableRun(store, boundChatId));
}

/**
 * **The run in flight as the table is given it** — the one builder for the frame and the snapshot.
 *
 * `currentRun` is the run as the owner's own devices follow it, reasoning and all. A guest's copy of
 * the story goes through `chatForGuest`, which takes a secret's words out of the agents' records,
 * and the run used to go out beside it unscrubbed: a Director thinking "I'll write to secrets: …"
 * reached every seat live, under "You only". In flight the secret is in no record yet, so there is
 * nothing to scrub it against: the reasoning is withheld, and a guest reads it once it lands,
 * through the committed copy's one door. `content` is the parsed display text, tags already out.
 */
function tableRun(store: ChatState, chatId: string): RunStatePayload {
  const run = currentRun(store, chatId);
  const streams = Object.fromEntries(Object.entries(run.streams).map(([agent, stream]) => [agent, { ...stream, thinking: "" }]));
  return { ...run, streams, ...hostReveal(store, chatId) };
}

/**
 * **The table's reading, for every seat to draw** (ROUND-2026-11-03 §2). The host's own reveal while
 * it is the reader; otherwise the reveal the guest reading the table sent up (`TABLE_READING_KIND`),
 * or the last one there was when nobody's screen shows the story. Always sent: the table's reading
 * is the table's, not the host's screen's. It used to be sent only while the host had the story on
 * screen, and with the host on another chat every guest read on at its own pace.
 */
function hostReveal(store: ChatState, chatId: string): { reveal: PublishedReveal | null } {
  const { reader, selfId } = room();
  const chat = readChat(chatId);
  if (chat && reader !== null && reader === selfId && store.activeChatId === chatId) {
    noteTableReading(chatId, publishedRevealOf(chat, pipelineFor(store, chatId).generatingMessageId ?? null));
  }
  return { reveal: tableReadingOf(chatId) };
}


/**
 * Send the turn's picture, at most every `STREAM_RELAY_MS`, and only when it has changed.
 *
 * A `frame` carries the whole picture, so a lost one costs a beat of smoothness and the next
 * covers it — and a newer one supersedes an older still waiting rather than queueing behind it
 * (`lib/net/outbox.ts`).
 *
 * **Except the last one, which has no next.** *"The next covers it"* is true of every frame of a
 * run and false of the one that ends it: `relayPipelineChange` fires when the slice moves, the
 * slice has just stopped moving, so a single refused POST there left a guest's status box
 * generating and a live bubble standing until somebody started another turn. A run that ends in a
 * commit was covered by accident — `applyAppend` puts the slice back to rest when the ids match —
 * and a run that ends in Stop or an error appends nothing at all, so nothing covered it
 * (`.agents/SYNC.md` §11.2).
 *
 * `isGenerating` is the whole of the test, and it is not a list of fields somebody chose: it is
 * the one that means *more is coming*. While it is true another frame is guaranteed to follow, so
 * this one may be dropped; once it is false this picture is the run's conclusion and is a fact
 * about the table rather than a picture of a moment — which is what `state` is for. Both verbs
 * supersede on the same queue, so a newer frame still replaces a conclusion still waiting and the
 * ordering is untouched.
 */
function queueRun(payload: RunStatePayload): void {
  pendingRun = payload;
  if (runTimer) return;
  runTimer = setTimeout(() => {
    runTimer = null;
    if (!pendingRun) return;
    const next = pendingRun;
    pendingRun = null;
    const shape = JSON.stringify(next);
    if (shape === relayedRun) return;
    relayedRun = shape;
    const intent = { kind: RUN_STATE_KIND, data: next };
    if (next.state.isGenerating) room().wire?.frame(intent);
    else room().wire?.state(intent);
  }, STREAM_RELAY_MS);
}

/** The host's diffing and relay baselines, back to rest — leaving the room clears both. */
function resetHostBaselines(): void {
  // The chain dies with the room. A fresh one is minted on the next assertion, and its new
  // epoch is what tells a guest still holding the old one to adopt whatever it is handed.
  storyRev = null;
  syncedMessages = null;
  syncedRest = null;
  cancelResnapshot();
  pendingRun = null;
  relayedRun = "";
  if (runTimer) {
    clearTimeout(runTimer);
    runTimer = null;
  }
}

/**
 * A minted card is a placeholder wearing whatever the table calls its player, so a rename
 * moves it. A card they *brought* (`player_card`) or filled in is theirs, and keeps its own
 * name — which is why the test is "has it any content of its own" rather than a flag.
 *
 * One predicate, asked in the two places a lobby name meets a card: here, when the roster
 * changes, and at commit time, where a guest's line is written as somebody.
 */
function wearsLobbyName(card: Character): boolean {
  return !card.description && !card.image;
}

/**
 * Every guest has a character card from the moment they sit down: player-role, named
 * after their account, empty-faced until they claim or bring one. Minted *before* the
 * snapshot that welcomes them, so their identity is in the first byte every tab reads —
 * a card minted lazily on first message arrived by append ahead of the debounced roster
 * snapshot, and for those 400ms their line wore the narrator's face.
 *
 * It also carries a rename through to the card, which is the half a rename could not reach
 * on its own: the roster is live session state and dies with the room, but the card is in
 * the story and is what every past and future bubble is drawn from.
 *
 * **A card is found by the seat, never by the name.** Coming back to the table as yourself is
 * the seat token's job: the room answers a token it already knows with the participant it
 * already is (`joinRoom` in `plugins/multiplayer/server/rooms.ts`), so a reload or a rejoin arrives with the
 * same id and this finds their card by it. A lookup by lobby name was added beside that, and
 * it handed an absent player's card — their portrait, their description, and through the
 * card every line they had written, edit and delete rights included — to whoever next sat
 * down under the same name. Names are not unique, and the one every unnamed reader gets is
 * "Player". It would also have given a kicked guest their seat back under a fresh one.
 */
function ensureGuestCards(): void {
  const chat = hostingChat();
  if (!chat) return;
  const missing = room().roster.filter(
    (p) => !p.isHost && !chat.characters.some((c) => c.id === playerCharacterId(p.id))
  );
  const renamed = room().roster.filter((p) => {
    const card = chat.characters.find((c) => c.id === playerCharacterId(p.id));
    return !p.isHost && card && wearsLobbyName(card) && card.name !== p.name;
  });
  if (missing.length === 0 && renamed.length === 0) return;
  // Quietly: seating the room's guests is the table's bookkeeping, done as the room says hello
  // and as guests join or rename, not the host changing the story (`lib/chat/touched.ts`).
  quietly(() => mutateChat(chat.id, (draft) => {
    for (const p of missing) {
      const id = playerCharacterId(p.id);
      draft.characters.push({
        id,
        name: p.name,
        description: "",
        image: null,
        isAutoGenerated: false,
        isAutoEdited: false,
        isNew: false,
        states: [],
        roleSetting: "user",
      });
      if (!draft.characterIds.includes(id)) draft.characterIds.push(id);
    }
    // Replaced, never written into (AGENTS.md §1): the clone shares element objects with the
    // state before it, so `card.name = …` renamed the previous generation's card too, and
    // anything memoised on that object never saw the new name.
    if (renamed.length > 0) {
      const nameOf = new Map(renamed.map((p) => [playerCharacterId(p.id), p.name]));
      draft.characters = draft.characters.map((c) => {
        const next = nameOf.get(c.id);
        return next === undefined ? c : { ...c, name: next };
      });
    }
  }));
}



/**
 * This tab's reading, named — the guest's half of `ReadingMark`.
 *
 * The reveal cursor is a position in *this* tab's rendered turns, which includes the reply
 * still streaming at `messages.length`; that bubble's id is the pipeline slice's
 * `generatingMessageId`, the id the host commits it under. So is `through`: a reader watching
 * a reply arrive holds that reply.
 */
function readingMark(): ReadingMark | undefined {
  return readingMarkOf(room().boundChatId);
}


/**
 * A guest said something: commit it as them, through the host's own mutation path — and,
 * in live mode, treat it exactly like the host's own send: cut the narration in flight
 * (the Writer commits what arrived, so the player's line lands *after* the partial it
 * interrupted — the order both screens must agree on), then hand the turn to the AI.
 *
 * `mark` is where the sender's reading had got to — the burst they talked over is cut
 * there and their line goes in at that position, exactly what `sendTurn` does for the
 * host's own finger. Without it a guest's interrupt landed after the *whole* burst: the
 * request was aborted, but every committed chunk still played out and the line queued
 * behind them all. It is placed on the host's own transcript by `placeReadingMark`, once
 * the interrupt has settled, and a mark it cannot place cuts nothing.
 *
 * With AI off this is pure human mode: the line lands, the turn is the player's own
 * (`holdTurn`), and nothing is owed — so re-enabling AI later does not answer a message
 * from an hour ago.
 */
function commitPlayerMessage(
  from: string,
  text: string,
  mark?: ReadingMark,
  typing?: boolean,
  sendId?: string,
  armed: readonly ArmedAction[] = [],
  images: readonly MessageImage[] = [],
  files: readonly MessageFile[] = []
): void {
  commitQueue = commitQueue.then(async () => {
    const { boundChatId } = room();
    if (!boundChatId) {
      refuse(from, PLAYER_MESSAGE_KIND, NO_STORY, sendId);
      return;
    }
    // The turn rules are enforced where the record is written: a guest whose screen
    // lagged the floor still cannot land a line out of turn — and is told so, rather than
    // watching the composer clear on a line that went nowhere.
    const floorBefore = tableFloorFor(boundChatId);
    if (floorBefore && !maySpeakNow(floorBefore.rules, floorBefore.view, playerSeat(from))) {
      refuse(from, PLAYER_MESSAGE_KIND, "It isn't your turn yet.", sendId);
      return;
    }

    // The reply the Writer was writing, if their line stopped it mid-stream: the line cut it short.
    const writing = await app.turns.interrupt(boundChatId);
    // The room can end while the interrupt unwinds; a commit after that writes nowhere.
    if (room().boundChatId !== boundChatId) {
      refuse(from, PLAYER_MESSAGE_KIND, "The table left that story before your line landed.", sendId);
      return;
    }
    // ...and the floor can move while it unwinds — a window shutting, a clock running out — so
    // the gate is asked again of the floor as it now stands, not as it stood before the wait.
    const floorNow = tableFloorFor(boundChatId);
    if (floorNow && !maySpeakNow(floorNow.rules, floorNow.view, playerSeat(from))) {
      refuse(from, PLAYER_MESSAGE_KIND, "It isn't your turn yet.", sendId);
      return;
    }

    /**
     * **Everything the write decides on is read now, after the wait — never before it.**
     *
     * These were read at the top and used down here, across the `await` above (AGENTS.md §1): so
     * the host switching AI off while the interrupt unwound still wrote the line as "the AI
     * answers next", and a claim given up in that moment still committed the line as the
     * character they had just let go. Read once, here, so the write and the start below agree.
     */
    const { roster, enableAI, claims, permissions } = room();
    const name = roster.find((p) => p.id === from)?.name ?? "Player";

    // A claimed cast member speaks with their own face and name; the claim is validated
    // again here, not just when granted — the character can have left the chat since.
    // Through the one identity ladder every rendering surface reads (`seat-identity.ts`),
    // so who a line is committed as and who a tab draws it as cannot drift apart.
    const chatNow = readChat(boundChatId);
    const claimedChar = chatNow ? claimedCharacterFor(chatNow, from, claims) : null;
    /**
     * **The tags in their line, read as the host's own are** (`lib/chat/player-tags.ts`) — and only
     * while the table may edit characters and worlds, the right a state change or a lore entry is a
     * write under, as it is for what they armed below. Without it the line lands as the words they
     * typed, tags and all, and they are told why.
     */
    const words = permissions.editLibrary ? playerLineWords(chatNow?.chatSettings, text) : { content: text };
    if (!permissions.editLibrary && playerLineWords(chatNow?.chatSettings, text).raw !== undefined) {
      refuse(from, PLAYER_MESSAGE_KIND, "The host has closed character and world edits to the table, so the tags in your line were not read.");
    }
    const charId = claimedChar ? claimedChar.id : playerCharacterId(from);

    // Named before the write, because what the sender armed is anchored to it — see below.
    const messageId = crypto.randomUUID();
    const batched = floorNow?.rules.batch ?? false;
    // What the mark came to on the host's copy; written inside the mutation, read after it.
    let cursor = null as TurnCursor | null;
    mutateChat(boundChatId, (draft) => {
      const speaker = draft.characters.find((c) => c.id === charId);
      if (!speaker) {
        draft.characters.push({
          id: charId,
          name,
          description: "",
          image: null,
          isAutoGenerated: false,
          isAutoEdited: false,
          isNew: false,
          states: [],
          roleSetting: "user",
        });
      } else if (!claimedChar && wearsLobbyName(speaker) && speaker.name !== name) {
        // A bare minted card wears the lobby name, so a rename between sessions follows
        // them in. A card they brought (`player_card`) or claimed keeps its own name.
        // Replaced rather than written into — see `ensureGuestCards`.
        draft.characters = draft.characters.map((c) => (c.id === charId ? { ...c, name } : c));
      }
      if (!draft.characterIds.includes(charId)) draft.characterIds.push(charId);

      const message: Message = {
        id: messageId,
        role: "user",
        ...words,
        speakerCharacterId: charId,
        timestamp: Date.now(),
        ...(images.length > 0 ? { images: [...images] } : {}),
        ...(files.length > 0 ? { files: [...files] } : {}),
      };
      // Placed on the draft — the host's transcript as it stands after the interrupt, which
      // is the only one a position may be taken from.
      cursor = mark ? placeReadingMark(draft, mark) : null;
      if (cursor) {
        // The same two calls the host's own send makes, at the sender's cursor. Guarded
        // on presence: `cutAtCursor(null)` means "keep nothing", and a mark that could not
        // be placed means "after everything".
        interruptWithLine(draft, message, { cursor, typing: typing === true, writing });
      } else {
        draft.messages.push(message);
        markInterruptedBy(draft, message.id, [writing]);
      }
      // Which place in the round this line took, if it took one — before the turn moves on.
      stampRoundEntry(draft, message);
      draft.lastSpeakerId = charId;
      if (batched || !enableAI) {
        // In a batched window — and in pure human mode — who speaks next is not this line's
        // decision: the window closing (or nobody) answers it.
        holdTurn(draft, charId);
      } else {
        // The same call the host's composer makes: the round's next place, or the AI answers.
        handOverTurn(draft, null);
      }
      if (!draft.storyStarted) draft.storyStarted = true;
    });

    // The host was reading that burst too — stand the reveal down so it re-derives, but
    // **never forward**: reset to the earlier of the host's own position and the cut.
    // Resetting to the guest's cursor outright jumped the host's reveal ahead, so the
    // chunks the host hadn't watched yet — the very ones the guest talked over — landed
    // on the host's screen all at once instead of typing out like they do on the guest's.
    if (cursor && app.story.chats.get().activeChatId === boundChatId) {
      const hostCursor = app.story.chats.get().uiState.reveal.cursor;
      resetReveal(hostCursor && cursorAtOrBefore(hostCursor, cursor) ? hostCursor : cursor);
    }
    // The line took the place a retried reply was waiting for — a card holding the story, or the
    // reply cut away unread under it — so that reply is back, before the line. The run's own end
    // has already put back one the interrupt cut off with nothing written.
    returnCarriedTakes(boundChatId);

    /**
     * **What they armed in the state drawer, spent on the line they just sent.**
     *
     * The guest's own send path returns before `spendArmedActions`, so a guest who lit a
     * torch and pressed send spent nothing at all: the chips stayed over their composer,
     * the state never moved on any screen, and nothing said why. It travels with the
     * message and is applied here, after the write and against that message's id — so a
     * rewind past the turn takes the change back out with it, exactly as the host's own does.
     *
     * The gate is `editLibrary`, because a state change is a write to a card and that is the
     * one right the table has for those. **Validity is not a second gate here**: the host's
     * record is what `applyArmedActions` is handed, and it asks `armedProblem` of every
     * action itself — a filter on the way in would be a second copy of that rule, free to
     * disagree with the one the reader's own screen asked.
     */
    if (armed.length > 0 && room().permissions.editLibrary) {
      const chatForStates = readChat(boundChatId);
      if (chatForStates) applyArmedActions(boundChatId, chatForStates, armed, { line: messageId });
    } else if (armed.length > 0) {
      // The line is in the story; only what was armed with it is refused. No send id — see
      // `refuse` — or the words would go back in a box whose line had already landed.
      refuse(from, PLAYER_MESSAGE_KIND, "The host has closed character and world edits to the table.");
    }

    // Their line is *here*, so the promise of it is spent — whether or not the "I stopped"
    // they sent as their box cleared ever arrived. The trigger is the local arrival and
    // nothing else: `until` is stamped on this machine and `timestamp` on theirs, so a rule
    // that compared the two would hide every draft at a table whose clocks disagree, or
    // clear none of them, with nothing failing either way.
    room().clearTyping(from);
    // Read before the turn is asked for, as the host's own line is (`readPlayerLineTools`).
    if (words.raw !== undefined) await readPlayerLineTools(boundChatId, messageId);

    if (batched) {
      room().windowLine(from, null);
    } else if (enableAI) {
      app.turns.start(boundChatId);
    }
  }).catch((err) => {
    // A commit that throws must not *become* the queue. `.then` on a rejected promise skips
    // every callback chained after it, so one failure here would silently swallow every
    // later line from every guest for the rest of the session — and the rejection itself
    // would have nobody to report it.
    console.error("[room] a guest's line could not be committed", err);
  });
}

/**
 * **A guest pressed Stop** — answered by the host, on the host's terms.
 *
 * It was `stopTurn` on arrival, unconditionally. `stopTurn` is the host's own Stop: it halts the
 * run, cuts, writes "the reader is up" into the chat's queue and puts the floor down for the
 * table. So a guest's Stop that reached a host with nothing running — a reply that had finished
 * while the press was in flight, or a guest's own reveal still typing a burst out — rewrote the
 * turn state of a story nobody was writing, and under turn rules handed the mic away from
 * whoever held it. And it asked nothing of the table: a guest who could not have said a word
 * out of turn could stop the voice whose turn it was.
 *
 * Two questions:
 *
 *  - **May this guest stop the story?** `stopReplies`, the row in the Multiplayer tab — and that
 *    row is the whole answer. It used to be the turn rules (`maySpeakNow`, the gate a line
 *    passes), which no screen said and no host could change, so at a mic table a guest's Stop
 *    was dead unless they held the floor. The composer asks the same row before it offers the
 *    button; this is the check that grants.
 *  - **Is there a run to stop?** The host's own pipeline slice for the story it is hosting,
 *    which is the slice every guest's Stop button was drawn from. Nothing running is refused
 *    with a sentence and touches nothing — the right is to stop a reply, not to rewrite the
 *    turn state of a story nobody is writing.
 */
function applyStopGeneration(from: string, mark?: ReadingMark): void {
  const { boundChatId, permissions } = room();
  if (!boundChatId) {
    refuse(from, STOP_GENERATION_KIND, NO_STORY);
    return;
  }
  if (!permissions.stopReplies) {
    // Revoked while the press was on the wire, or a screen drawn before the row was turned off.
    refuse(from, STOP_GENERATION_KIND, "The host has not given the table Stop.");
    return;
  }
  if (!pipelineFor(app.story.chats.get(), boundChatId).isGenerating) {
    refuse(from, STOP_GENERATION_KIND, "Nothing was being written by then.");
    return;
  }
  // Placed once the run has settled, on what it left: the Writer commits the prose that
  // arrived on its way out, and that is the message a streaming reader's mark names.
  void stopTurn(boundChatId, mark ? (chat) => placeReadingMark(chat, mark) : undefined);
}

/**
 * A player brought their own card: put its face and words on their minted character.
 * The id stays `playerCharacterId(from)` — the card is *how they look*, the account is
 * *who they are* — so a different card next week replaces this one instead of seating a
 * second copy of them at the table.
 */
function applyPlayerCard(from: string, card: PlayerCardPayload): void {
  const { boundChatId } = room();
  if (!boundChatId) return;
  const charId = playerCharacterId(from);
  // The same normaliser the roster's names go through — `playerName` is documented as the one
  // place a raw name becomes a displayable one, and this door was going round it, so a card's
  // name was bounded only by the 8 MB intent ceiling and rode every snapshot into the host's
  // prompt. An empty one is still nothing to wear rather than the default name, because that
  // would rename somebody's card to "Player" on a save that meant to change a portrait.
  if (!card.name?.trim()) return;
  const name = playerName(card.name);

  mutateChat(boundChatId, (draft) => {
    /**
     * **Replaced, not written into** — `.agents/AGENTS.md` §1.
     *
     * This wrote `speaker.name = …` onto an element of `draft.characters`, which is a card
     * mutated in place. It reached every screen anyway, for a reason that has now gone: the diff
     * that decides whether the room needs the whole truth compared the `characters` *array* by
     * reference, and `cloneChatForMutation` replaces that array on every mutation, so the answer
     * was "yes" whatever anybody did to the contents. With the diff honest, an in-place write is
     * a card the room is never told about — silently, on the guest's own portrait.
     *
     * `restOfChat` does not depend on this being right (it compares content), and that is
     * deliberate: the rule still has to be kept, and the check still may not be the thing that
     * assumes it was.
     */
    const at = draft.characters.findIndex((c) => c.id === charId);
    const existing = at >= 0 ? draft.characters[at] : null;
    /**
     * **The list is the door, and nothing else on the payload is read.**
     *
     * This spread the payload and then wrote `states` off it, so the one door that asks no
     * permission carried story content: a guest with "Edit characters & worlds" revoked wrote
     * states — and therefore links — onto a real card in the host's chat, with no refusal, no
     * `StateChange` to rewind it, and the host's next snapshot broadcasting it to the table.
     *
     * The dressing is *picked* now, one key per name in `PLAYER_CARD_FIELDS`, and the
     * annotation makes tsc keep the two in step in both directions: a name added to the list
     * must be picked here, and a key that is not on the list is an excess property and cannot
     * be written.
     */
    const dressing: Pick<Character, PlayerCardField> = {
      name,
      description: typeof card.description === "string" ? card.description : "",
      image: typeof card.image === "string" ? card.image : null,
      imageTransform: card.imageTransform,
    };
    const next: Character = {
      ...(existing ?? {
        id: charId,
        description: "",
        image: null,
        isAutoGenerated: false,
        isAutoEdited: false,
        isNew: false,
        states: [],
        roleSetting: "user",
      }),
      ...dressing,
      id: charId,
    };
    // An absent transform means "no crop", so it is deleted rather than left standing from the
    // record this one replaces.
    if (!next.imageTransform) delete next.imageTransform;

    if (at >= 0) draft.characters[at] = next;
    else draft.characters.push(next);
    if (!draft.characterIds.includes(charId)) draft.characterIds.push(charId);
  });
  // The roster changed with no message moving — `broadcastChatChange` re-snapshots.
}

/**
 * A guest asked to edit or delete a line. The permission table answers; the shared
 * turn-edit helpers apply — the same functions the host's own buttons call, so a
 * granted right does exactly what the host's finger would. The change is a non-append
 * transcript mutation, so `broadcastChatChange` re-sends the truth to everyone.
 */
function applyMessageAction(from: string, payload: MessageActionPayload): void {
  const { boundChatId, claims, permissions } = room();
  /**
   * **Every way out of here says something.**
   *
   * Three of these returned in silence, with the two below that refuse sitting immediately
   * beside them: so a guest's edit to a line the host had since deleted, retried away or
   * rewound past simply vanished — no `intent_refused`, and their own copy unchanged, so
   * nothing on either screen said anything at all. A send that is answered "no" is a send
   * the reader can do something about; one that is answered with nothing is a bug report.
   */
  if (!boundChatId) {
    refuse(from, MESSAGE_ACTION_KIND, NO_STORY);
    return;
  }
  const message = messageForTurnId(boundChatId, payload.turnId);
  const chat = readChat(boundChatId);
  if (!message || !chat) {
    refuse(from, MESSAGE_ACTION_KIND, "That line is no longer in the story — nothing was touched.");
    return;
  }
  // A bubble is addressed by where it stood in the guest's copy of the message; if the message
  // is not the one they were looking at, that position names a different line here.
  if (parseChunkTurnId(payload.turnId) && payload.base !== message.content) {
    refuse(from, MESSAGE_ACTION_KIND, "That reply changed before your change reached it — nothing was touched.");
    return;
  }
  if (!guestMayActOnMessage(payload.action, { chat, ownerId: from, claims, permissions, message })) {
    refuse(
      from,
      MESSAGE_ACTION_KIND,
      payload.action === "edit" ? "That line is not yours to edit." : "That line is not yours to delete."
    );
    return;
  }

  // The host's own buttons refuse while something writes against the chat, and so does this:
  // one door for a structural change (`restructureChat`), which also stands the host's reveal
  // down — a guest's delete mid-reveal left the cursor past the new end.
  if (!mayRestructure(boundChatId)) {
    refuse(from, MESSAGE_ACTION_KIND, "The story is being written — try again once the turn is over.");
    return;
  }
  if (payload.action === "edit" && payload.answer) {
    // The same door the host's own press goes through, so a granted right does what their finger would.
    const { atOffset, edit } = payload.answer;
    let problem: string | null = null;
    restructureChat(boundChatId, () => (problem = editAnswer(boundChatId, message.id, atOffset, edit)) === null);
    if (problem) refuse(from, MESSAGE_ACTION_KIND, `${problem} — nothing was touched.`);
    return;
  }
  if (payload.action === "edit") {
    // Words, or pictures, or both — the same rule the composer sends by.
    const limits = attachmentLimits(readChat(boundChatId)?.chatSettings);
    const images = payload.images === undefined ? undefined : guestPictures(payload.images, limits);
    const keepFiles = Array.isArray(payload.files) ? new Set(guestFiles(payload.files, limits).map((f) => f.id)) : undefined;
    const files = keepFiles && (message.files ?? []).filter((own) => keepFiles.has(own.id));
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content.trim() && !(images && images.length > 0) && !(files && files.length > 0)) {
      refuse(from, MESSAGE_ACTION_KIND, "An edit needs words or a picture — delete the line instead.");
      return;
    }
    // A picture the line already carries keeps what the host wrote about it; only a new one
    // arrives bare, to be described the way a fresh line's are.
    const kept = images?.map((image) => message.images?.find((own) => own.id === image.id) ?? image);
    restructureChat(boundChatId, () => applyTurnEdit(boundChatId, payload.turnId, content, kept, files));
  } else {
    restructureChat(boundChatId, () => applyTurnDelete(boundChatId, payload.turnId));
  }
}

/**
 * The guest side of an edit or delete — `useChatEngine` routes here instead of writing.
 * The result comes back as the host's snapshot; until it does, the line stands as it
 * was, which is honest about who owns the record.
 */
export function sendMessageAction(
  action: MessageAction,
  turnId: string,
  content?: string,
  images?: readonly MessageImage[],
  files?: readonly MessageFile[]
): void {
  const { boundChatId } = room();
  const held = parseChunkTurnId(turnId) && boundChatId ? messageForTurnId(boundChatId, turnId) : undefined;
  void toHost()?.event({
    kind: MESSAGE_ACTION_KIND,
    data: {
      action,
      turnId,
      ...(held ? { base: held.content } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(images !== undefined ? { images: [...images] } : {}),
      ...(files !== undefined ? { files: [...files] } : {}),
    } satisfies MessageActionPayload,
  });
}

/**
 * The guest side of an answer edit — a call or its answer rewritten on a Writer's message. A
 * request like every edit: the host's permission table answers and its snapshot brings the result.
 */
export function sendAnswerEdit(messageId: string, atOffset: number, edit: AnswerEdit): void {
  void toHost()?.event({
    kind: MESSAGE_ACTION_KIND,
    data: { action: "edit", turnId: messageId, answer: { atOffset, edit } } satisfies MessageActionPayload,
  });
}

/**
 * A guest wrote a Director's note.
 *
 * Filed through `queueInjection` — the same function the host's own composer calls — so a
 * granted right does exactly what the host's finger would: the same seam, the same anchor,
 * the same replacement-by-id. The author is the *account*, because a note is not spoken by
 * anybody and a card can be handed back; it is what lets the person who wrote a note read it
 * whatever the table's visibility policy says.
 *
 * `clampLifetime` because the number came from a control with a range, and a lifetime of
 * `NaN` — which `typeof x === "number"` is perfectly happy with — is a note that decays
 * never and reads as a bug in the decay rule. Here rather than at the wire, because a number
 * that is not one becomes this chat's own starting count, and the chat is known here.
 */
function applyDirectorNote(from: string, note: DirectorNotePayload): void {
  const { boundChatId, permissions } = room();
  if (!boundChatId) {
    refuse(from, DIRECTOR_NOTE_KIND, NO_STORY, note.id);
    return;
  }
  if (!permissions.writeNotes) {
    // The composer checks this too, and it is still only courtesy there: the right can be
    // revoked while the note is in flight, which is one of the three ways a send used to
    // disappear with the sound of a successful one.
    refuse(from, DIRECTOR_NOTE_KIND, "The host has closed Director's notes to the table.", note.id);
    return;
  }
  const content = note.content.trim();
  if (!content) return;
  const { id: _id, lifetimeReplies, ...direction } = note;
  const lifetime =
    lifetimeReplies === undefined
      ? {}
      : { lifetimeReplies: clampLifetime(lifetimeReplies, tuning(readChat(boundChatId)?.chatSettings, "composer").noteLifetime) };
  queueInjection(boundChatId, { ...direction, ...lifetime, content, authorOwnerId: from });
}

/**
 * The guest side of a note — `useChatEngine` routes here instead of filing into a copy of
 * the chat the next snapshot overwrites, which is what a guest's note used to do before the
 * composer started refusing them outright.
 */
export function sendDirectorNote(note: NoteDirection): void {
  const id = crypto.randomUUID();
  sendTyped(
    { kind: DIRECTOR_NOTE_KIND, data: { ...note, id } satisfies DirectorNotePayload },
    DIRECTOR_NOTE_KIND,
    id,
    note.content
  );
}

/**
 * The guest side of a proposal verdict. Its one caller is `proposalWriter`, which is the
 * only thing in the app that writes a proposal record — a pane handler cannot reach past
 * it to apply a verdict locally, which is what three of them used to do.
 */
export function sendProposalAction(payload: ProposalActionPayload): void {
  void toHost()?.event({ kind: PROPOSAL_ACTION_KIND, data: payload });
}

/**
 * A guest's verdict, applied through the very functions the host's own pane calls — the
 * proposal record has one set of writers and this is it, so a guest's approve and the
 * host's are the same code reached from two doors. The permission table answers first;
 * the pipeline is nudged the safe way (`checkAndRecover` starts nothing when nothing is
 * owed).
 */
function applyProposalAction(from: string, payload: ProposalActionPayload): void {
  const { boundChatId, permissions } = room();
  if (!boundChatId) return;
  if (!permissions.approveProposals) {
    // The pane refuses this before sending; the host says it again for the case the pane
    // cannot see — the right taken back while the verdict was on the wire.
    refuse(from, PROPOSAL_ACTION_KIND, "Proposal approvals are the host's.");
    return;
  }
  const chat = readChat(boundChatId);
  const bundle = chat?.proposalBundles?.find((b) => b.id === payload.bundleId);
  if (!bundle) {
    refuse(from, PROPOSAL_ACTION_KIND, APPROVE_REFUSED.gone);
    return;
  }

  /**
   * No status gate here beyond this one. Every writer below owns its own rule and they
   * do not agree, on purpose: `denyProposalAction` accepts an auto-rejected bundle so
   * that "put it back" works at the moment it matters most, and the restores accept
   * only a rejected one. The blanket `isPendingBundle` this replaces was a second copy
   * of those rules and was wrong for both.
   *
   * `edit` is the one writer with no rule of its own, and it needs one: the payload is
   * the record of what was applied, so it may only be rewritten while still open.
   */
  if (payload.action === "edit" && !isPendingBundle(bundle)) {
    refuse(from, PROPOSAL_ACTION_KIND, APPROVE_REFUSED.settled);
    return;
  }

  switch (payload.action) {
    case "approve": {
      // A guest's edits are read as the card's own boxes would have written them — never a
      // whole payload of the guest's choosing (`guest-proposal-edits.ts`).
      const edits = guestBundleEdits(bundle, payload.edits, (right) => permissions[right]);
      if ("refused" in edits) {
        refuse(from, PROPOSAL_ACTION_KIND, edits.refused);
        return;
      }
      const refused = applyProposalBundle(boundChatId, payload.bundleId, edits.value);
      if (refused) refuse(from, PROPOSAL_ACTION_KIND, refused);
      break;
    }
    case "reject":
      rejectProposalBundle(boundChatId, payload.bundleId);
      break;
    case "edit": {
      const action = typeof payload.actionId === "string" ? bundle.actions.find((a) => a.id === payload.actionId) : undefined;
      if (!action) {
        refuse(from, PROPOSAL_ACTION_KIND, APPROVE_REFUSED.gone);
        return;
      }
      const edited = guestActionEdit(action, payload.payload, (right) => permissions[right]);
      if ("refused" in edited) {
        refuse(from, PROPOSAL_ACTION_KIND, edited.refused);
        return;
      }
      updateProposalAction(boundChatId, payload.bundleId, action.id, edited.value);
      break;
    }
    case "deny":
      if (typeof payload.actionId !== "string") return;
      denyProposalAction(boundChatId, payload.bundleId, payload.actionId, payload.denied !== false);
      break;
    case "restore":
      // A card's own actions, or the whole bundle when the card names none — the same
      // two doors the host's pane has, told apart by what the guest sent.
      if (payload.actionIds?.length) {
        restoreProposalAction(boundChatId, payload.bundleId, payload.actionIds);
      } else {
        restoreProposalBundle(boundChatId, payload.bundleId);
      }
      break;
  }
  app.turns.recover(boundChatId);
}

/**
 * Wear one of your own cards at this table. Guests send it up; the host applies its own
 * directly — one write path either way, the host's `applyPlayerCard`.
 */
export function wearPlayerCard(card: PlayerCardPayload): void {
  const { isHost, selfId } = room();
  // Built key by key off the list rather than spread: the lobby picker hands this a whole
  // shelf card, states and links and all, and the wire may carry the dressing alone.
  const payload: PlayerCardPayload = {
    name: card.name,
    description: card.description ?? "",
    image: card.image ?? null,
    ...(card.imageTransform ? { imageTransform: card.imageTransform } : {}),
  };
  if (isHost) {
    if (selfId) applyPlayerCard(selfId, payload);
    return;
  }
  toHost()?.state({ kind: PLAYER_CARD_KIND, data: payload });
}

/**
 * A guest's edit in a manager — a character save, a world save, an import, a delete, an
 * activation toggle — edits a view the next snapshot will overwrite. The managers route
 * every write through here so the change travels up and comes back applied in the host's
 * snapshot. Two doors on the host side, on purpose:
 *
 *  - **their own minted card** goes as the `player_card` intent the lobby picker sends —
 *    dressing your own seat is your identity, never a permission;
 *  - **everything else** goes as `library_edit`, which the host applies only while the
 *    `editLibrary` right is granted. Revoked, the managers render read-only besides —
 *    but the host's check is the one that decides.
 */
export function forwardLibraryEdit(chatId: string, edit: LibraryEditPayload, base?: unknown): void {
  const { phase, isHost, boundChatId, selfId } = room();
  if (phase !== "lobby" || isHost || boundChatId !== chatId || !selfId) return;
  /**
   * What the guest actually changed, worked out here rather than at each manager — one
   * rule, and neither screen can send a whole-record overwrite by forgetting it. `base`
   * is the record as this tab held it before the save; without one there is nothing to
   * compare, and the whole record travels as it always did.
   */
  const changed =
    edit.action === "upsert" && edit.entity !== "folder" && base && typeof base === "object"
      ? changedKeys(base as Record<string, unknown>, edit.record)
      : null;

  /**
   * **Their own card is two doors, not one.**
   *
   * It used to be one: every save of the card the session minted for this account went as
   * `player_card`, which carries the dressing and nothing else — so a guest who put a sword
   * in their own hands, or linked their character to a world, watched it apply on their own
   * screen and vanish with the host's next snapshot. Nothing said no; the states simply were
   * not on the wire.
   *
   * The split is by *what changed*, never by which card. Dressing is identity and needs no
   * permission; states are story content and go where the `editLibrary` right answers —
   * which is the same door, and the same rule, as for any other card in the chat.
   */
  if (
    edit.entity === "character" &&
    edit.action === "upsert" &&
    (edit.record as Partial<Character>).id === playerCharacterId(selfId)
  ) {
    const keys = changed ?? Object.keys(edit.record);
    if (keys.some(isDressing)) wearPlayerCard(edit.record as Character);
    const rest = keys.filter((key) => !isDressing(key));
    if (rest.length === 0) return;
    void toHost()?.event({ kind: LIBRARY_EDIT_KIND, data: { ...edit, fields: rest } });
    return;
  }

  // A folder travels whole: it is a name and a place, with nothing a later snapshot could clobber.
  const outgoing: LibraryEditPayload =
    edit.action === "upsert" && edit.entity !== "folder" && changed ? { ...edit, fields: changed } : edit;
  void toHost()?.event({ kind: LIBRARY_EDIT_KIND, data: outgoing });
}

/** The keys whose value differs, by value — including one the save removed. */
function changedKeys(base: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  return [...keys].filter((key) => JSON.stringify(base[key]) !== JSON.stringify(next[key]));
}

/**
 * The host's side of a guest's manager edit: the permission table answers, then the same
 * storage writers the host's own managers call apply it — so a granted right does
 * exactly what the host's finger would, snapshot broadcast included.
 */
function applyLibraryEdit(from: string, edit: LibraryEditPayload): void {
  const { boundChatId, permissions } = room();
  if (!boundChatId) return;
  if (!permissions.editLibrary) {
    refuse(from, LIBRARY_EDIT_KIND, "The host has closed character and world edits to the table.");
    return;
  }

  if (edit.entity === "folder") {
    applyFolderEdit(boundChatId, edit);
    return;
  }

  if (edit.action === "upsert") {
    const record = edit.record as Record<string, unknown> & { id?: unknown };
    // An id, and nothing else asked of the record here: every field is read by the table below.
    // This also asked for a `name`, which a world does not have — so a world a guest made in
    // their manager was dropped on the floor with nothing said.
    if (!record || typeof record !== "object" || typeof record.id !== "string") {
      console.warn("[story-sync] A library edit named no card:", record);
      return;
    }
    /**
     * **A guest may not re-dress another person — which is a rule about fields, not cards.**
     *
     * It used to refuse the whole record, and that refused too much. A link is a state, and
     * a state lives on the card that *owns* the other one — so "this world is carried by
     * Bo's character" is written onto Bo's minted card, and a reader binding two cards from
     * the world's own pane had the write silently dropped because of whose face happened to
     * be on the far end of it.
     *
     * Their name and their portrait are still theirs alone: those keys are stripped, and a
     * save that was *only* dressing is refused out loud rather than swallowed.
     *
     * **The host is a person at the table too.** Only a *minted* card was asked about, so a
     * guest could rename the host's own persona, or give it their face, from the character
     * manager — the one card at the table that is never minted.
     */
    const chatHere = readChat(boundChatId);
    const othersCard =
      edit.entity === "character" &&
      (isOthersPlayerCard(record.id, from) || (!!chatHere && personaCharacterOf(chatHere)?.id === record.id));
    const fields = Array.isArray(edit.fields)
      ? edit.fields.filter((key) => !othersCard || !isDressing(key))
      : null;
    if (othersCard && (!fields || fields.length === 0)) {
      refuse(from, LIBRARY_EDIT_KIND, "That card is another player's face — theirs to change.");
      return;
    }

    /**
     * Only the keys the guest changed, onto the host's *current* record.
     *
     * The record on the wire was built from the guest's snapshot, which is as old as the
     * last broadcast — so writing it whole put every field back to what it was then. A
     * state the host had spent since came back; nothing recorded that it had, so nothing
     * could undo it. The guest's own screen agreed with the host afterwards, about the
     * wrong number, which is why it went unnoticed.
     */
    const here = (edit.entity === "character" ? chatHere?.characters : chatHere?.worlds)?.find(
      (e: { id: string }) => e.id === record.id
    ) as Record<string, unknown> | undefined;
    /**
     * **Naming no fields may only mean "a card that is not here yet".**
     *
     * `fields` is the sender's word, and whether the host already holds this card is a thing
     * the host can check for itself — so it does. Without this, a save that simply omitted
     * the list was assigned whole, which is the overwrite above with no refusal in front of
     * it: every field the host had moved since the guest's last snapshot came back. The
     * honest client always names its fields when it has a base (`lib/cards/save-card.ts`),
     * and it has a base exactly when the card is here.
     */
    if (here && !fields) {
      refuse(from, LIBRARY_EDIT_KIND, "That card changed here — reopen it and make the edit again.");
      return;
    }
    /**
     * A card that is not here may not arrive wearing an id the chat hands out itself — the
     * narrator's, the host's own, or one minted for a seat. It is a new card only in name: it
     * would *be* that identity from the moment it landed.
     */
    if (!here && isReservedCardId(record.id)) {
      refuse(from, LIBRARY_EDIT_KIND, "That card belongs to somebody at the table — it cannot be made from here.");
      return;
    }
    /**
     * **Only the fields a guest may write, each read to its type** (`GUEST_CARD_FIELDS`).
     *
     * Every key the guest named was copied as it came. So `description: {}` was stored and every
     * prompt the host built afterwards threw; the narrator's `systemPrompt` was one field away,
     * which is writing the system prompt of the host's own requests; `retrievalKeys` ran a
     * guest's `/pattern/` on the host's main thread; and `roleSetting: "user"` on the narrator
     * let a guest claim it and take edit and delete over every line it had ever written.
     *
     * A value of the wrong type refuses the whole save — half a save written is a card neither
     * screen described. A field the host keeps is left alone and the guest told so; bookkeeping
     * a manager's save carries (`isNew`, a shelf's folder, an import's carried corners) is left
     * alone and not mentioned, because it was never the guest's to say.
     */
    const named = (fields ?? Object.keys(record)).filter((key): key is string => typeof key === "string" && key !== "id");
    const writable = GUEST_CARD_FIELDS[edit.entity];
    // Own keys only: `"constructor" in {}` is true, and a guest names the keys.
    const kept = named.filter((key) => Object.hasOwn(HOST_KEEPS, key));
    const read = readOrRefusal(() =>
      Object.fromEntries(named.filter((key) => Object.hasOwn(writable, key)).map((key) => [key, writable[key](record[key])]))
    );
    if ("refused" in read) {
      refuse(from, LIBRARY_EDIT_KIND, read.refused);
      return;
    }
    const keptSentence = `The host keeps a card's ${kept.map((key) => HOST_KEEPS[key]).join(" and ")} — ${
      kept.length === 1 ? "that was" : "those were"
    } not changed.`;
    if (Object.keys(read.value).length === 0) {
      if (kept.length > 0) refuse(from, LIBRARY_EDIT_KIND, keptSentence);
      return;
    }
    const next = here ? { ...here, ...read.value } : { id: record.id, ...read.value };

    if (edit.entity === "character") upsertCharacter(boundChatId, next as unknown as Character);
    else upsertWorld(boundChatId, next as never);
    if (kept.length > 0) refuse(from, LIBRARY_EDIT_KIND, keptSentence);
    return;
  }
  if (typeof edit.id !== "string") return;
  /**
   * **A guest's card becoming a cast card** — behind the same right as every other card edit, not
   * the own-card door: it takes a card out of the cast and moves every reference to it, which is
   * the story's content, not the guest's dressing. Into the sender's own minted card and nobody
   * else's; `absorbCard` refuses a card that is a person's or the narrator's.
   */
  if (edit.action === "absorb") {
    let absorbed = false;
    mutateChat(boundChatId, (draft) => {
      absorbed = absorbCard(draft, playerCharacterId(from), edit.id);
    });
    if (!absorbed) refuse(from, LIBRARY_EDIT_KIND, "That card can't become yours — it is somebody's, or it has gone.");
    return;
  }
  /**
   * **A player's card is in the story because a person is at the table** — not a card the
   * library edit may take out of it.
   *
   * Delete already refused one, silently; switching one out of the chat was not asked at all, so
   * a guest could take another player's card out of the scene from the character manager, and
   * that player's next line went on committing as a card the chat no longer counted in its cast.
   * Both of the verbs that decide whether a card is *in the story* ask the same question now,
   * and say so when the answer is no. Re-dressing is the upsert's rule, above.
   *
   * **And it is the manager's own question** (`lib/cards/cast-rules.ts`). This asked only about
   * minted cards, while the manager also kept its bin off the narrator and its switch off the
   * host's persona and any card the chat marks player-controlled — rules a guest's screen held
   * and the host did not, so one intent the manager would never send deleted the narrator.
   */
  if (edit.entity === "character") {
    const card = readChat(boundChatId)?.characters.find((c) => c.id === edit.id) ?? { id: edit.id };
    const allowed = edit.action === "delete" ? mayDeleteCharacter(card) : mayLeaveStory(card);
    if (!allowed) {
      // Only a person's card is refused here: the narrator is a card like any other.
      refuse(from, LIBRARY_EDIT_KIND, "A player's card stays in the story while they are at the table.");
      return;
    }
  }
  if (edit.action === "delete") {
    if (edit.entity === "character") deleteCharacter(boundChatId, edit.id);
    else deleteWorld(boundChatId, edit.id);
    return;
  }
  if (edit.action === "setActive") {
    setEntityInChat(boundChatId, edit.entity, edit.id, edit.active === true);
  }
}

/**
 * A guest's lorebook edit, on the host: each lorebook read to its shape (an id, a name, a parent)
 * and written through the writers the host's own world manager calls. One that will not read is
 * dropped and said in the console, as a card naming no id is.
 */
function applyFolderEdit(chatId: string, edit: Extract<LibraryEditPayload, { entity: "folder" }>): void {
  // Read off the wire, so a guest cannot name a list that is not theirs to write — the story's arcs.
  const kind = edit.of === "character" ? "character" : edit.of === "world" ? "world" : null;
  if (!kind) {
    console.warn("[story-sync] A folder edit named no manager's folders:", edit.of);
    return;
  }
  if (edit.action === "delete") {
    const ids = Array.isArray(edit.ids) ? edit.ids.filter((id): id is string => typeof id === "string") : [];
    deleteChatFolders(chatId, kind, ids);
    return;
  }
  const folder = edit.record as Partial<ChatFolder> | undefined;
  if (!folder || typeof folder.id !== "string" || typeof folder.name !== "string" || !folder.name.trim() || (folder.parentId !== null && typeof folder.parentId !== "string")) {
    console.warn("[story-sync] A folder edit named no folder:", folder);
    return;
  }
  upsertChatFolders(chatId, kind, [{ id: folder.id, name: folder.name.slice(0, MAX_GUEST_CARD_NAME), parentId: folder.parentId ?? null }]);
}

// ─── Guest: render what arrives ──────────────────────────────────────────────────────────

function adoptSnapshot(raw: Partial<Chat>, rev: Revision | null, run: RunStatePayload | null): void {
  /**
   * Backwards is the only thing a snapshot is refused for.
   *
   * It was `!isNewer`, which also refused an **equal** one — and the answer to a resync request
   * is very often equal, because a snapshot aimed at one reader no longer steps the chain
   * (§11.1). A guest would have thrown away the truth it had just asked for and gone on asking.
   *
   * A snapshot is the whole story, so applying a generation this tab already holds is a no-op
   * rather than a risk; `isNewer` is the test an *append* wants and `isStale` the test a whole
   * value wants. See `plugins/multiplayer/client/revision.ts`.
   */
  if (rev && isStale(rev, heldRev)) return;
  // Through the same normaliser every other outside chat passes — a snapshot from a
  // host with newer fields must not explode a guest running yesterday's build.
  const chat = normalizeChat(raw);
  const before = readChat(chat.id);
  setGuestChat(chat);
  heldRev = rev;
  useRoomStore.setState({ boundChatId: chat.id });
  const store = app.story.chats.get();
  if (store.activeChatId === chat.id) {
    app.story.chats.set({ activeChat: chat });
    standRevealDown(before, chat);
  }
  /**
   * **The rest of the screen catches up with the story** — see `StorySnapshotPayload.run`.
   *
   * The reply this tab was watching being written may be *in* the snapshot: that is the commit,
   * and the commit is the stream's ending whether or not anything else said so — the rule
   * `applyAppend` already follows, for the case where the append itself was what went missing.
   * Then the host's run as it stood when the truth was taken, which is also what a host on an
   * older build that sends none leaves alone.
   */
  const streaming = pipelineFor(store, chat.id).generatingMessageId;
  if (streaming && chat.messages.some((m) => m.id === streaming)) {
    store.setRelayedRun(chat.id, (relayed) => relayed && { ...relayed, ...PIPELINE_AT_REST });
  }
  if (run) applyRunState(run);
}

/**
 * **Ask the host for whatever this tab is behind on.**
 *
 * Deliberately *idempotent and cheap*: it says what this tab holds and nothing else, so asking
 * twice costs a snapshot the guest would have taken anyway. There is no retry logic here
 * because there does not need to be one — it goes as an `event`, which is retried until it
 * lands (`lib/net/outbox.ts`).
 *
 * Guests only. A host asking itself for the story is the shape that would quietly make the
 * authoritative copy a follower of somebody else's.
 */
function requestResync(): void {
  if (room().phase !== "lobby") return;
  void toHost()?.event({ kind: RESYNC_REQUEST_KIND, data: { storyRev: heldRev } satisfies ResyncRequestPayload });
}

/**
 * The host's side of it: hand that reader the truth.
 *
 * One door, and it answers the same way whatever the question was — the snapshot *is* the
 * answer to "what am I behind on", and working out a minimal delta would be a second
 * description of the story that could disagree with the first.
 */
function answerResync(to: string): void {
  // Already promised one: it goes at the window's end and carries whatever is true then, which
  // answers every request that arrived meanwhile.
  if (resyncOwed.has(to)) return;
  const wait = (resyncAnswered.get(to) ?? -Infinity) + RESYNC_ANSWER_MS - Date.now();
  const answer = () => {
    resyncOwed.delete(to);
    resyncAnswered.set(to, Date.now());
    sendSnapshot(to);
  };
  if (wait <= 0) answer();
  else resyncOwed.set(to, setTimeout(answer, wait));
}

/**
 * **The least time between two snapshots one seat's resync requests are answered with.**
 *
 * The request is a few bytes and the answer is the whole chat — scrubbed for that reader
 * (`chatForGuest` walks all of it), serialised with its pictures, and sent up through the host's
 * seat and out through the tunnel. Every request was answered at once, so a guest who sent them as
 * fast as the relay took them had the host's tab rebuilding and uploading the story without pause
 * (sweep 2026-11-01, S3). An honest guest asks on a re-seat, a reconnect, or an append it cannot
 * place — moments apart at most — and a request inside the window is still answered, once, when it
 * closes.
 */
const RESYNC_ANSWER_MS = 2_000;
/** Per seat: when a resync was last answered, and the answer owed at the end of the window. */
const resyncAnswered = new Map<string, number>();
const resyncOwed = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The transcript changed shape under the reveal — put it back where it can still walk.
 *
 * This is `endReveal` for a reader who does not own the record. The host calls it itself on
 * every rewrite (a retry, a swipe, a delete, a prune): the animation cannot keep walking a
 * transcript that just lost its tail, and a cursor left pointing past the cut marks the turns
 * that *replace* it as already seen. Nobody was doing it for guests, which is exactly the
 * report — the host swiped, the regenerated reply arrived under a stale cursor, and the whole
 * of it appeared at once with no typing animation at all.
 *
 * Derived from the snapshot rather than mirrored per mutation kind, for the reason the
 * snapshot itself exists: there are many ways a transcript is rewritten and a hook per way is
 * a list that goes stale.
 *
 * **Never forward.** A reader still behind the divergence keeps their place — the same rule a
 * guest's interrupt follows on the host's own screen.
 */
function standRevealDown(before: Chat | undefined, after: Chat): void {
  if (!before) return; // first sight of the chat: opening it reveals it whole
  const at = divergingTurnIndex(before.messages, after.messages);
  if (at === null) {
    // Appended, or rewritten in place — a truncated burst holds fewer bubbles than the place the
    // guest was reading at: fitted, not stood down (`fitRevealTo`).
    fitRevealTo(after);
    return;
  }
  const cursor = app.story.chats.get().uiState.reveal.cursor;
  if (!cursor) return; // nothing revealed yet — there is nothing to put back
  const surviving = at > 0 ? cursorAtEndOfMessage(after, at - 1) : null;
  if (surviving && cursorAtOrBefore(cursor, surviving)) return;
  resetReveal(surviving);
}

function applyAppend(message: Message, base: Revision | null, rev: Revision | null): void {
  const chatId = room().boundChatId;
  if (!chatId) return;
  /**
   * **Does this follow what I hold?**
   *
   * The question the story could not ask. An append that names a revision this tab never
   * reached means a line went missing between them — so rather than pushing it on top of a
   * hole and rendering a transcript that is quietly wrong, the guest says so and asks for the
   * truth. The message itself is dropped: the snapshot that comes back carries it.
   *
   * An append *older* than what this tab holds is re-delivered mail and is neither a hole nor
   * news — the id check below already covers it, so it is deliberately not a resync.
   */
  if (base && rev) {
    if (!isNewer(rev, heldRev)) return;
    if (!follows(base, heldRev)) {
      requestResync();
      return;
    }
  }
  mutateChat(chatId, (draft) => {
    // Re-delivered mail after a reconnect, or an append racing a snapshot that already
    // carried it — the id decides, not arrival count.
    if (draft.messages.some((m) => m.id === message.id)) return;
    draft.messages.push(message);
    if (message.speakerCharacterId !== undefined) {
      draft.lastSpeakerId = message.speakerCharacterId;
    }
  });
  if (rev) heldRev = rev;
  /**
   * The sender's draft is spent: their line is here. The host's commit clears it on the host's
   * screen (`commitPlayerMessage`); every other screen holds the same ghost, and kept it until the
   * sender's "I stopped" arrived or it timed out, beside the line it promised. Local arrival is the
   * trigger, as there — never a comparison of two machines' clocks.
   */
  const view = readChat(chatId);
  const table = tableFor(view);
  const sender = view && table && message.speakerCharacterId ? ownerOfSpeaker(view, table, message.speakerCharacterId) : null;
  if (sender) room().clearTyping(sender);
  // The commit is the stream's ending, whether or not the `done` chunk survives the
  // wire — a live bubble for a message the transcript now holds would render twice.
  const store = app.story.chats.get();
  if (pipelineFor(store, chatId).generatingMessageId === message.id) {
    store.setRelayedRun(chatId, (relayed) => relayed && { ...relayed, ...PIPELINE_AT_REST });
  }
}


function applyRunState(run: RunStatePayload): void {
  const chatId = room().boundChatId;
  if (!chatId) return;
  applyRunStateToChat(chatId, run);
  // The table's reading, as the host relays it. What a seat does with it (draws it, or walks it as
  // the reader) is the gate watcher's, from this one value (`plugins/multiplayer/client/continue-gate.ts`).
  if (run.reveal !== undefined) noteTableReading(chatId, run.reveal);
}

/**
 * **A guest reader's reveal the table may not take** — past a hold the table has not released, or
 * behind the reading the table was last shown.
 *
 * The reader is a guest's client. Taken by shape alone, one that claimed the story while the host was
 * away could publish "nothing behind, no hold": a hold is opened from the reader's own published gate,
 * so a client that never publishes one never has a hold opened, and the host landed the reply and
 * offered Next turn without the presses "Wait for everyone" asks for. So the host works out the holds
 * itself: the bubbles of the story as a transcript draws them (`tableTurnsOf`), from the place it last
 * accepted, held after by the rule the reveal holds by (`holdsForReader`). The reader may move up to
 * the next hold and stand there; past it only once the table has released it (`wentOn`). Moving back
 * would redraw every other seat backwards, and is refused too.
 *
 * A hold on a bubble a person's line has been spoken after holds nothing, as the host speaking ends
 * its own hold. A place this copy cannot name any more (a cut, a retry) leaves nothing to judge from,
 * and the reading is taken.
 */
function refusesReading(chatId: string, incoming: PublishedReveal | null): boolean {
  const walk = tableWalk(chatId);
  if (!walk) return false;
  const to = incoming?.at ? walk.indexOf(incoming.at) : -1;
  // Nowhere this copy can name, or behind what the table was shown.
  return to < walk.from || walk.heldBefore(to);
}

/**
 * **A guest's line would pass a hold the table has not released** — the same walk as a reading.
 * A line lands after the bubble its mark is placed at (`placeReadingMark`), or after the whole
 * reply when it cannot be placed, and speaking there is standing there: past a held Continue only
 * once the table has released it.
 *
 * Only a line with *no* mark used to be asked, so a mark naming the last bubble of the reply, which
 * is "after everything", walked past "Wait for everyone" (sweep 2026-11-05 M3).
 */
function linePassesHold(chatId: string, mark: ReadingMark | undefined): boolean {
  const walk = tableWalk(chatId);
  const chat = readChat(chatId);
  if (!walk || !chat) return false;
  const placed = mark && placeReadingMark(chat, mark) ? walk.indexOf(mark) : -1;
  return walk.heldBefore(placed >= 0 ? placed : walk.last);
}

/**
 * The bubbles of the table's story, where the reading the host last accepted stands among them, and
 * which of them hold the table — or null when there is nothing to judge from (no reading yet, no
 * pacing, or a place this copy cannot name any more: a cut, a retry).
 */
function tableWalk(
  chatId: string
): { from: number; last: number; indexOf: (at: NonNullable<PublishedReveal["at"]>) => number; heldBefore: (to: number) => boolean } | null {
  const chat = readChat(chatId);
  const accepted = tableReadingOf(chatId);
  if (!chat || !accepted?.at) return null;
  const animation = resolveAnimation(chat.chatSettings.animation);
  if (!revealPacesTurns(animation)) return null;
  const turns = tableTurnsOf(chat, pipelineFor(app.story.chats.get(), chatId));
  const indexOf = (at: NonNullable<PublishedReveal["at"]>) => {
    const exact = turns.findIndex((t) => t.originalMessage.id === at.messageId && t.chunkIndex === at.chunkIndex);
    return exact >= 0 ? exact : turns.findLastIndex((t) => t.originalMessage.id === at.messageId);
  };
  const from = indexOf(accepted.at);
  if (from < 0) return null;
  const { wentOn } = room();
  const spokenAfter = (messageId: string) => {
    const index = chat.messages.findIndex((m) => m.id === messageId);
    return index >= 0 && chat.messages.slice(index + 1).some((m) => m.role === "user");
  };
  const holdsAt = (i: number) => {
    const turn = turns[i];
    return !!turn && holdsForReader(turn, animation) && !wentOn.includes(readGateId(turn.id)) && !spokenAfter(turn.originalMessage.id);
  };
  /** A hold the table has not released between where it stands and bubble `to`. */
  const heldBefore = (to: number) => {
    for (let i = from; i < to; i++) if (holdsAt(i)) return true;
    return false;
  };
  return { from, last: turns.length - 1, indexOf, heldBefore };
}

/** What a guest hears when its line could not be placed while the table is held at a Continue. */
const LINE_PAST_HOLD = "Your line was not sent: the table is waiting at a Continue you haven't reached together yet. Try again.";


/**
 * **The reader's reveal, sent up** — a guest the host named the table's reader publishes what it
 * walks, at the relay's pace, and only while it is the reader with the story on screen. The host
 * relays it to everyone else in the run's frames.
 */
let readingSent = "";
let readingTimer: ReturnType<typeof setTimeout> | null = null;
function sendTableReading(): void {
  readingTimer = null;
  const { isHost, reader, selfId, boundChatId } = room();
  if (isHost || !boundChatId || reader === null || reader !== selfId || !showsStory()) return;
  const chat = readChat(boundChatId);
  if (!chat) return;
  const reveal = publishedRevealOf(chat, pipelineFor(app.story.chats.get(), boundChatId).generatingMessageId ?? null);
  const body = JSON.stringify(reveal);
  if (body === readingSent) return;
  readingSent = body;
  // A state: a newer place supersedes one still queued, and one sent while the wire is down lands.
  toHost()?.state({ kind: TABLE_READING_KIND, data: { reveal } satisfies TableReadingPayload });
}
function scheduleTableReading(): void {
  if (!readingTimer) readingTimer = setTimeout(sendTableReading, STREAM_RELAY_MS);
}

// ─── The wiring ──────────────────────────────────────────────────────────────────────────

function onRelayIntent(from: string, intent: RoomIntent): void {
  const { isHost, roster } = room();

  if (isHost) {
    if (intent.kind === TABLE_READING_KIND) {
      // Only from the seat the host named; a guest cannot steer the table by publishing.
      const bound = room().boundChatId;
      const reveal = readReveal((intent.data as Partial<TableReadingPayload> | undefined)?.reveal);
      if (bound && reveal !== undefined && from === room().reader && from !== room().selfId && !refusesReading(bound, reveal)) {
        noteTableReading(bound, reveal);
        relayPipelineChange(app.story.chats.get());
      }
    }
    if (intent.kind === PLAYER_MESSAGE_KIND) {
      const data = intent.data as Partial<PlayerMessagePayload> | undefined;
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      // Shape-first: a malformed mark degrades to a plain append, never to a cut.
      const mark = readReadingMark(data?.mark);
      const sendId = typeof data?.id === "string" ? data.id : undefined;
      // Shape only: what each one *means* is `armedProblem`, asked at the host below —
      // the same validator, in the same words, the reader's own screen asked.
      const armed = Array.isArray(data?.armed)
        ? (data.armed.filter(
            (a) => a && typeof a === "object" && typeof (a as ArmedAction).type === "string"
          ) as ArmedAction[])
        : [];
      const bound = room().boundChatId;
      const limits = attachmentLimits(bound ? readChat(bound)?.chatSettings : undefined);
      const images = guestPictures(data?.images, limits);
      const files = guestFiles(data?.files, limits);
      if (text || images.length > 0 || files.length > 0) {
        if (bound && linePassesHold(bound, mark)) {
          refuse(from, PLAYER_MESSAGE_KIND, LINE_PAST_HOLD, sendId);
        } else {
          commitPlayerMessage(from, text, mark, data?.typing === true, sendId, armed, images, files);
        }
      }
    }
    if (intent.kind === LIBRARY_EDIT_KIND) {
      const data = intent.data as Partial<LibraryEditPayload> | undefined;
      if (
        data &&
        (((data.entity === "character" || data.entity === "world") &&
          (data.action === "upsert" || data.action === "delete" || data.action === "setActive" || data.action === "absorb")) ||
          (data.entity === "folder" && (data.action === "upsert" || data.action === "delete")))
      ) {
        applyLibraryEdit(from, data as LibraryEditPayload);
      }
    }
    if (intent.kind === PROPOSAL_ACTION_KIND) {
      const data = intent.data as Partial<ProposalActionPayload> | undefined;
      if (data && isProposalIntentAction(data.action) && typeof data.bundleId === "string") {
        applyProposalAction(from, {
          action: data.action,
          bundleId: data.bundleId,
          ...(data.edits && typeof data.edits === "object"
            ? { edits: data.edits as Record<string, unknown> }
            : {}),
          ...(typeof data.actionId === "string" ? { actionId: data.actionId } : {}),
          // `payload` is the card's own data and may legitimately be anything, null
          // included — so it is carried when it is *present*, not when it is truthy.
          ...(data && "payload" in data ? { payload: data.payload } : {}),
          ...(typeof data.denied === "boolean" ? { denied: data.denied } : {}),
          ...(Array.isArray(data.actionIds)
            ? { actionIds: data.actionIds.filter((id): id is string => typeof id === "string") }
            : {}),
        });
      }
    }
    if (intent.kind === MESSAGE_ACTION_KIND) {
      const data = intent.data as Partial<MessageActionPayload> | undefined;
      if (
        data &&
        (data.action === "edit" || data.action === "delete") &&
        typeof data.turnId === "string"
      ) {
        applyMessageAction(from, {
          action: data.action,
          turnId: data.turnId,
          ...(typeof data.content === "string" ? { content: data.content } : {}),
          ...(Array.isArray(data.images) ? { images: data.images } : {}),
          ...(Array.isArray(data.files) ? { files: data.files } : {}),
          ...(typeof data.base === "string" ? { base: data.base } : {}),
          ...(guestAnswerEdit(data.answer) ? { answer: guestAnswerEdit(data.answer) } : {}),
        });
      }
    }
    if (intent.kind === DIRECTOR_NOTE_KIND) {
      const data = intent.data as Partial<DirectorNotePayload> | undefined;
      if (data && typeof data.content === "string") {
        applyDirectorNote(from, {
          content: data.content,
          ...(typeof data.id === "string" ? { id: data.id } : {}),
          ...(typeof data.targetCharacterId === "string"
            ? { targetCharacterId: data.targetCharacterId }
            : {}),
          ...(typeof data.lifetimeReplies === "number" ? { lifetimeReplies: data.lifetimeReplies } : {}),
        });
      }
    }
    if (intent.kind === PLAYER_CARD_KIND) {
      const data = intent.data as Partial<PlayerCardPayload> | undefined;
      if (data && typeof data.name === "string") {
        /**
         * **Read here, at the wire — not in `applyPlayerCard`, which the host's own wear calls
         * too.** This door asks no permission, and it stored whatever arrived: a portrait that was
         * a link to a stranger's server (an `<img>` on the host's screen is a request that hands
         * over the address the tunnel hides), a crop of `scale: 1e308`, and a description two
         * million characters long that every prompt on the host's key then carried.
         */
        const name = data.name;
        const read = readOrRefusal((): PlayerCardPayload => {
          const crop = readGuestCrop(data.imageTransform);
          return {
            name,
            description: readGuestText("description", data.description ?? ""),
            image: readGuestPicture(data.image),
            ...(crop ? { imageTransform: crop } : {}),
          };
        });
        if ("refused" in read) refuse(from, PLAYER_CARD_KIND, read.refused);
        else applyPlayerCard(from, read.value);
      }
    }
    if (intent.kind === RESYNC_REQUEST_KIND) {
      answerResync(from);
    }
    if (intent.kind === STOP_GENERATION_KIND) {
      const data = intent.data as Partial<StopGenerationPayload> | undefined;
      applyStopGeneration(from, readReadingMark(data?.mark));
    }
    return;
  }

  // Guests believe story traffic from the host alone — `from` is server-stamped, so a
  // guest cannot feed the table a forged transcript.
  const host = roster.find((p) => p.isHost);
  if (!host || from !== host.id) return;

  if (intent.kind === INTENT_REFUSED_KIND) {
    const data = intent.data as Partial<IntentRefusedPayload> | undefined;
    if (data && typeof data.of === "string" && typeof data.reason === "string") {
      announceRefusal(data.of, data.reason, typeof data.id === "string" ? data.id : undefined);
    }
  }
  if (intent.kind === STORY_SNAPSHOT_KIND) {
    const data = intent.data as Partial<StorySnapshotPayload> | undefined;
    if (data?.chat && typeof data.chat === "object") {
      adoptSnapshot(data.chat, readRevision(data.rev), readRun(data.run));
    }
  }
  if (intent.kind === STORY_APPEND_KIND) {
    const data = intent.data as Partial<StoryAppendPayload> | undefined;
    if (data?.message && typeof data.message === "object" && typeof data.message.id === "string") {
      // A malformed or absent pair reads as "no idea", and an append with no idea is applied
      // the way every append was before there were revisions — degrading to the old behaviour
      // rather than refusing a host running an older build.
      applyAppend(data.message as Message, readRevision(data.base), readRevision(data.rev));
    }
  }
  if (intent.kind === RUN_STATE_KIND) {
    const run = readRun(intent.data);
    if (run) applyRunState(run);
  }
}


/**
 * The guest composer's send path — `useChatEngine` routes here instead of committing.
 * The tab's own reading rides along, named (`ReadingMark`): it is where this reader's story
 * had got to, and the host cuts the burst there — when it can place it — as it would for its
 * own send.
 */
export function sendPlayerStoryMessage(
  text: string,
  images: readonly MessageImage[] = [],
  files: readonly MessageFile[] = []
): void {
  const trimmed = text.trim();
  if (!trimmed && images.length === 0 && files.length === 0) return;
  const reveal = app.story.chats.get().uiState.reveal;
  const mark = readingMark();
  const id = crypto.randomUUID();
  /**
   * ...and what they armed in the state drawer, which is spent by this turn.
   *
   * Cleared here because this *is* the guest's `spendArmedActions`: the chips come off the
   * composer when the send leaves, the same moment they do on the host's own path. Cleared
   * after the send is handed over, never before — a send this refused would otherwise throw
   * away what the player had set up with nothing to say where it went.
   */
  const armed = app.story.chats.get().uiState.armedActions;
  sendTyped(
    {
      kind: PLAYER_MESSAGE_KIND,
      data: {
        text: trimmed,
        id,
        ...(mark ? { mark, typing: reveal.typing !== null } : {}),
        ...(armed.length > 0 ? { armed: [...armed] } : {}),
        ...(images.length > 0 ? { images: [...images] } : {}),
        ...(files.length > 0 ? { files: [...files] } : {}),
      } satisfies PlayerMessagePayload,
    },
    PLAYER_MESSAGE_KIND,
    id,
    trimmed
  );
  if (armed.length > 0) app.story.chats.get().setUIState({ armedActions: [] });
}

/**
 * The guest's Stop — asks the host to halt the run. `discard` says whether what this reader
 * had not read yet goes with it, and it travels as this tab's `ReadingMark`, never as a
 * position: the host places it on its own transcript or cuts nothing.
 */
export function sendStopGeneration(discard: boolean): void {
  const mark = discard ? readingMark() : undefined;
  void toHost()?.event({
    kind: STOP_GENERATION_KIND,
    data: { ...(mark ? { mark } : {}) } satisfies StopGenerationPayload,
  });
}

/**
 * Wire the module up, once per tab. Import-time on the client so every doorway into a
 * session (the lobby dialog, the chat engine) arms it by existing; explicit and
 * re-callable for tests, which run without a window and arm it themselves.
 */
export function initStorySync(): () => void {
  if (wired) return () => {};
  wired = true;
  const offs: (() => void)[] = [];
  // The table's continue gate arms with the sync: every doorway into a session arms
  // both by importing either.
  offs.push(initContinueGate());

  offs.push(observeRoomEvents((event) => {
    if (event.type === "relay") {
      onRelayIntent(event.from, event.intent);
      return;
    }
    const { isHost } = room();
    if (event.type === "hello") {
      if (isHost) {
        // Everyone already seated gets their card before the story is asserted.
        ensureGuestCards();
        // Baseline now; re-assert the story to a lobby that kept living through the
        // host's reconnect. A fresh room broadcasts to nobody, harmlessly.
        syncedMessages = hostingChat()?.messages ?? null;
        sendSnapshot();
      } else {
        /**
         * **A guest's own `hello` had no branch at all**, and that was a hole with no floor
         * under it: a seat evicted by the presence sweep re-seats on its next poll, gets a
         * `hello`, and was then told *nothing else ever again* unless the eviction happened to
         * also fire a `peer_joined` at the host. Now it asks, which is the whole of what a
         * tab that has just come back needs to do.
         */
        requestResync();
      }
      return;
    }
    if (event.type === "peer_joined" && isHost) {
      // Their card is minted first, so the snapshot that welcomes them already carries
      // their identity — every tab knows who they are before their first word.
      ensureGuestCards();
      sendSnapshot(event.player.id);
    }
    if (event.type === "peer_renamed" && isHost) {
      // The card follows the name. No snapshot is sent from here: the mutation is a chat
      // change like any other, and the subscription below broadcasts it to the whole table
      // — which is what a rename needs, unlike a join, which needs one guest catching up.
      ensureGuestCards();
    }
  }));

  /**
   * The host changed who may read a note — re-send the story.
   *
   * Watched here rather than pushed from the setter because this is where the redaction is,
   * and `roomStore` may not import this module. It is the same shape as the transcript diff
   * below: a remembered value, compared, and the truth re-sent when it moves. Without it the
   * only thing that would revisit a guest's sealed cards is the next unrelated chat mutation.
   */
  offs.push(useRoomStore.subscribe(() => {
    if (notePolicyKey() === syncedNotePolicy) return;
    syncedNotePolicy = notePolicyKey();
    // No-op unless this tab is hosting, like every other send in this module.
    sendSnapshot();
  }));

  // The host's own commits — typed turns, generated replies, approved edits — all pass
  // through the store; watching it is what makes the broadcast path one path. The
  // pipeline slice is watched the same way for the narration in flight.
  offs.push(app.story.chats.subscribe((state, prev) => {
    // The reader's reveal rides the run's frame, so every screen moves with it: the host's own, or
    // a guest reader's, sent up to be relayed.
    if (state.uiState.reveal !== prev.uiState.reveal && state.pipelines === prev.pipelines) relayPipelineChange(state);
    if (state.uiState.reveal !== prev.uiState.reveal || state.activeChatId !== prev.activeChatId) scheduleTableReading();
    if (state.pipelines !== prev.pipelines) {
      relayPipelineChange(state);
      // A run starting or ending moves whose turn it is, and the clock is keyed by that. Asked on
      // the edge only — the slice changes with every streamed chunk, and nothing about the floor does.
      const bound = room().boundChatId;
      if (bound && pipelineFor(state, bound).isGenerating !== pipelineFor(prev, bound).isGenerating) {
        room().syncFloor();
      }
    }
    if (state.activeChat === prev.activeChat) return;
    // Whose turn it is is the chat's own now (`lib/mic/floor.ts`), so a rules change or a card
    // leaving has nothing to restart and no holder to strand — the table's clock and window are
    // simply brought in line with the chat as it stands.
    if (room().isHost && state.activeChat?.id === room().boundChatId) room().syncFloor();
    broadcastHostedChat();
  }));

  /**
   * ...and again for every write that never touches the store.
   *
   * `mutateChat` has two branches: the open chat goes through `updateActiveChat` and fires the
   * subscription above, and **any other chat goes through `upsertChat`**, which writes the
   * record, the cache and the sync queue without the chat store hearing a thing. So while the
   * host stood on a different chat — forking a story mid-session is the door that holds it —
   * guest lines committed to the authoritative record and reached no screen at all, including
   * the sender's; a guest-approved proposal applied and left every HUD showing the old value;
   * and, because `relayPipelineChange` has no such gate, guests watched narration stream, got
   * `done`, and then saw the whole reply vanish when no append followed it.
   *
   * `onChatsChanged` is what that branch does reach, so it is the other trigger. Both
   * call one function that reads the **bound** chat rather than the open one, and calling it
   * twice for one change is harmless: `broadcastChatChange` diffs against its own baselines,
   * so the second call finds nothing to say.
   */
  offs.push(onChatsChanged(broadcastHostedChat));

  // Leaving or losing the room stops the host's diffing baseline from going stale.
  offs.push(useRoomStore.subscribe((state, prev) => {
    if (state.phase !== prev.phase && state.phase !== "lobby") {
      resetHostBaselines();
      // A guest's own chain goes with it: the next room is a different authority, and a stale
      // `heldRev` would make its first snapshot look like something already applied.
      heldRev = null;
    }
  }));

  /**
   * **The wire came back — find out what was said while it was gone.**
   *
   * The down-link re-delivers unacknowledged mail on its own, so this is not about what the
   * mailbox held. It is about what the *host* said into a POST that failed while this tab was
   * unreachable, and about a seat the room evicted and re-seated with a fresh mailbox. Neither
   * is visible from here, which is exactly why the answer is to ask rather than to reason.
   */
  offs.push(useRoomStore.subscribe((state, prev) => {
    if (state.wireStatus === "open" && prev.wireStatus !== "open") requestResync();
  }));

  /**
   * A guest's view of somebody else's story, dropped **once they have walked out of it.**
   *
   * `clearGuestChat` had no caller at all, so a guest who left, was kicked, or whose host
   * closed the room kept the whole shared chat parked in memory for the life of the tab.
   *
   * The timing is the load-bearing half. `isGuestChatId` is the gate every persistence funnel
   * asks — it is what stops a guest's copy of the host's story reaching their own library and
   * eating the host's turns on the next sync (MULTIPLAYER.md §3) — so clearing the view while
   * the reader is still standing in that chat opens exactly that door, for whatever write
   * lands next. Waiting for them to leave the screen costs nothing and cannot.
   */
  offs.push(app.story.chats.subscribe((state, prev) => {
    if (state.activeChatId === prev.activeChatId) return;
    if (prev.activeChatId && isGuestChatId(prev.activeChatId) && room().phase !== "lobby") {
      clearGuestChat();
    }
  }));
  return () => {
    wired = false;
    for (const off of offs.splice(0)) off();
  };
}


