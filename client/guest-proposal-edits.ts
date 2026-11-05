import { GuestRefusal, readGuestName, readGuestText, readOrRefusal } from "./guest-cards";
import type { GuestPermissionId } from "./permissions";
import { app } from "@dahlia/plugin-api";
import type { ProposalAction, ProposalBundle } from "@dahlia/plugin-api";

const { EDITABLE_FIELDS, STATE_SET_MODES } = app.proposals;

/**
 * **What a guest's edit to a proposal may change, read on the host.**
 *
 * A guest holding the "approve proposals" right can edit a card before approving it, and the
 * edit crossed the wire as a whole replacement payload that the host wrote in place of the
 * Director's — no field checked, no type checked. The card's own boxes only ever change the words
 * of a proposal; the wire could change what it *is*: point a state change at another card (the
 * host's own persona, the narrator), turn a state change into a standing helper with a prompt of
 * the guest's writing and every tool it cared to grant itself, or swap a new card's portrait for
 * a link that reports the host's address every time it is drawn.
 *
 * So a guest's edit is read as the boxes would have written it, over the Director's original:
 *
 *  - a state event keeps its kind, and only the fields `EDITABLE_FIELDS` names are taken — never
 *    one it marks `instructs`;
 *  - a `state_update` keeps the card it is about, and may change which of that card's facts it
 *    sets, how, and to what (the field editor's three controls);
 *  - a note keeps who it is to, how long it lasts and who may read it, and may change its words;
 *  - a call may name a different speaker (the speaker picker).
 *
 * Anything else is refused out loud, like every other guest write (`guest-cards.ts`).
 */

/** The actions a state change may take — the ones `<state_set>`'s modes make. */
const STATE_ACTIONS: ReadonlySet<string> = new Set(Object.values(STATE_SET_MODES));

type Payload = Record<string, unknown>;

function asRecord(raw: unknown, what: string): Payload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GuestRefusal(`That ${what} edit could not be read.`);
  return raw as Payload;
}

function readStateEvent(original: Payload, replacement: Payload): Payload {
  const kind = original.type;
  if (replacement.type !== kind) throw new GuestRefusal("An edit cannot turn a proposal into a different kind of change.");

  if (kind === "state_update") {
    const action = replacement.action;
    if (typeof action !== "string" || !STATE_ACTIONS.has(action)) {
      throw new GuestRefusal("That change's action could not be read.");
    }
    return {
      ...original,
      targetKey: readGuestName("field", replacement.targetKey),
      action,
      value: readGuestText("value", replacement.value),
    };
  }

  const fields = typeof kind === "string" ? EDITABLE_FIELDS[kind] : undefined;
  if (!fields) throw new GuestRefusal("That kind of proposal is not edited at this table; approve or decline it as it stands.");
  if (fields.instructs) throw new GuestRefusal("What a subagent is told to do stays the host's to write.");
  return {
    ...original,
    ...(fields.identityKey ? { [fields.identityKey]: readGuestName(fields.identityKey, replacement[fields.identityKey]) } : {}),
    [fields.proseKey]: readGuestText(fields.proseKey, replacement[fields.proseKey]),
  };
}

/**
 * The changes to a character or world card: the one thing a guest writes into the story by any door
 * (`applyLibraryEdit` takes a character or a world and nothing else). Named as what a guest may
 * write, so a kind added later is the host's until somebody says otherwise.
 */
const CARD_EVENTS: ReadonlySet<string> = new Set(["state_update", "character_add", "world_add"]);

/**
 * **The right that governs what an edit writes** (sweep 2026-11-05 M2), or `"host"` for what no
 * guest writes, or `null` for an edit the approval right covers (a call naming another speaker).
 *
 * Approving with edits was asked only `approveProposals`, so it was a second way round every right
 * that governs the same words elsewhere: with "Write Director's notes" off a guest edited a pending
 * note to any text and approved it, and with "Edit characters & worlds" off rewrote a new card's
 * prose. Approving *unedited* stays the approval right's alone.
 */
export function editRight(action: Pick<ProposalAction, "type" | "payload">): GuestPermissionId | "host" | null {
  if (action.type === "speaker_call") return null;
  if (action.type === "injection") return "writeNotes";
  const kind = (action.payload as { type?: unknown } | undefined)?.type;
  return action.type === "state_event" && typeof kind === "string" && CARD_EVENTS.has(kind) ? "editLibrary" : "host";
}

const NOT_YOURS: Partial<Record<GuestPermissionId | "host", string>> = {
  host: "That change is the host's to write; approve or decline it as it stands.",
  writeNotes: "Writing Director's notes is the host's at this table; approve or decline it as it stands.",
  editLibrary: "Editing characters & worlds is the host's at this table; approve or decline it as it stands.",
};

function readActionEdit(action: ProposalAction, raw: unknown, may: (right: GuestPermissionId) => boolean): unknown {
  const right = editRight(action);
  if (right !== null && (right === "host" || !may(right))) {
    throw new GuestRefusal(NOT_YOURS[right] ?? "That edit is the host's at this table.");
  }
  const original = asRecord(action.payload, "proposal");
  const replacement = asRecord(raw, "proposal");
  switch (action.type) {
    case "state_event":
      return readStateEvent(original, replacement);
    case "injection":
      return { ...original, content: readGuestText("note", replacement.content) };
    case "speaker_call":
      return { ...original, speakerId: readGuestName("voice", replacement.speakerId) };
    default:
      throw new GuestRefusal("That kind of proposal is not edited at this table; approve or decline it as it stands.");
  }
}

/** A guest's replacement for one action's payload, as the host will store it — or the refusal. */
export function guestActionEdit(
  action: ProposalAction,
  raw: unknown,
  may: (right: GuestPermissionId) => boolean
): { value: unknown } | { refused: string } {
  return readOrRefusal(() => readActionEdit(action, raw, may));
}

/**
 * A guest's edits map for an approve, each read against the bundle's own action — or the first
 * refusal. An id the bundle does not hold is refused rather than dropped: the approve would
 * otherwise go through without the edit the guest thought they were approving.
 */
export function guestBundleEdits(
  bundle: ProposalBundle,
  edits: Record<string, unknown> | undefined,
  may: (right: GuestPermissionId) => boolean
): { value: Record<string, unknown> | undefined } | { refused: string } {
  if (edits === undefined) return { value: undefined };
  if (!edits || typeof edits !== "object") return { refused: "Those edits could not be read." };
  const read: Record<string, unknown> = {};
  for (const id of Object.keys(edits)) {
    const action = bundle.actions.find((a) => a.id === id);
    if (!action) return { refused: "That edit names a change this proposal does not hold." };
    const one = guestActionEdit(action, edits[id], may);
    if ("refused" in one) return one;
    read[id] = one.value;
  }
  return { value: read };
}
