import { app } from "@dahlia/plugin-api";
import type { CardActivation, EntityState, Expression, ImageTransform, CardField } from "@dahlia/plugin-api";

const { isInlinePicture, readableImageTransform, CARD_FIELDS, WORLD_FIELDS, readableStateRows, MAX_STATE_DEPTH } = app.cards;

/**
 * **What a guest may write onto a card in the host's library, read as the host's own types.**
 *
 * A guest arrives over a public tunnel with a room code, and both card doors took their word for
 * what a field held: `player_card` (which asks no permission at all) stored a portrait that was a
 * link to somebody else's server and a two-million-character description, and every prompt the
 * host paid for carried it from then on. The host is the one whose keys, library and screen are at
 * stake, so each value is read here, on the host, before anything is written — and a value that
 * is not what the field holds is *refused out loud*, never quietly trimmed or emptied: a guest
 * whose save changed on the way in would otherwise watch their own edit come back different with
 * nothing saying why.
 *
 * A reader hands back the value or throws a `GuestRefusal` carrying the sentence the guest is
 * told; the door catches it once, around the whole read, so no field can be written by a save
 * another field of which was refused.
 */

export class GuestRefusal extends Error {}

/**
 * The longest a guest may make one field of a card.
 *
 * A generous card's description runs to a few thousand characters and SillyTavern cards past ten
 * thousand are rare, so this refuses nothing anybody writes by hand. It exists because every
 * character of it rides every prompt the host's key pays for, and a guest is somebody the host
 * handed a room code to, not their key.
 */
export const MAX_GUEST_CARD_TEXT = 20_000;

/** A field of words, under the ceiling. `label` names it in the refusal. */
export function readGuestText(label: string, raw: unknown): string {
  if (typeof raw !== "string") throw new GuestRefusal(`A card's ${label} has to be words.`);
  if (raw.length > MAX_GUEST_CARD_TEXT) {
    throw new GuestRefusal(
      `A card's ${label} at this table can be ${MAX_GUEST_CARD_TEXT.toLocaleString("en-US")} characters at most.`
    );
  }
  return raw;
}

/**
 * What a guest is told when a portrait or a face they sent is a link to a picture. A portrait is drawn
 * wherever the card is, so it is the picture itself or none. A web picture written in a guest's
 * *words* is taken: the renderer draws no web picture while this tab is at a table (`useAtTable`,
 * `components/MarkdownText.tsx`), on the host's screen or any guest's.
 */
export const LINKED_PICTURE_REFUSAL = "A picture at this table has to be the picture itself, not a link to one.";

/** A portrait: the picture itself (`isInlinePicture`), or none. */
export function readGuestPicture(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (!isInlinePicture(raw)) throw new GuestRefusal(LINKED_PICTURE_REFUSAL);
  return raw;
}

/** A crop the positioning can read, or none — `readableImageTransform`, which every file's crop goes through. */
export function readGuestCrop(raw: unknown): ImageTransform | undefined {
  if (raw === null || raw === undefined) return undefined;
  const crop = readableImageTransform(raw);
  if (!crop) throw new GuestRefusal("That picture's crop could not be read.");
  return crop;
}

/**
 * The longest a guest may make a card's name or title. It is in every prompt that names the
 * card, and a name is a few words — this is a sentence's worth, and refuses no name.
 */
export const MAX_GUEST_CARD_NAME = 120;

/**
 * The most a guest may put in one card's states, as the JSON they travel as. States are story
 * content and go where every other field does — the host's prompt — so they are held to a
 * ceiling like the text is: four fields' worth, which is a long inventory with a line on
 * every item.
 */
export const MAX_GUEST_STATES_TEXT = 4 * MAX_GUEST_CARD_TEXT;

export function readGuestName(label: string, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new GuestRefusal(`A card's ${label} has to be words.`);
  if (raw.length > MAX_GUEST_CARD_NAME) {
    throw new GuestRefusal(`A card's ${label} at this table can be ${MAX_GUEST_CARD_NAME} characters at most.`);
  }
  return raw;
}

/** A field the card may leave empty: absent stays absent, anything else is words. */
const optionalText = (label: string) => (raw: unknown) => (raw === undefined ? undefined : readGuestText(label, raw));

function readGuestTextList(label: string, raw: unknown, each: (label: string, raw: unknown) => string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new GuestRefusal(`A card's ${label} have to be a list.`);
  return raw.map((entry) => each(label, entry));
}

/**
 * States: rows every reader can walk (`readableStateRows`, the door every card file's states
 * take), nested no deeper than the readers walk, and under the ceiling.
 *
 * The depth is asked *first*, with a walk that stops at the limit: a list nested a hundred
 * thousand deep fits in the intent ceiling, and every recursive reader — the row check, the
 * `JSON.stringify` that measures it — overflows the stack on it before it can say no.
 */
function readGuestStates(raw: unknown): EntityState[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new GuestRefusal("A card's states have to be a list.");
  const tooDeep = (rows: unknown[], depth: number): boolean =>
    depth > MAX_STATE_DEPTH ||
    rows.some((row) => {
      const nested = row && typeof row === "object" ? (row as { states?: unknown }).states : undefined;
      return Array.isArray(nested) && tooDeep(nested, depth + 1);
    });
  if (tooDeep(raw, 0)) throw new GuestRefusal(`A card's states can be nested ${MAX_STATE_DEPTH} deep at most.`);
  if (JSON.stringify(raw).length > MAX_GUEST_STATES_TEXT) {
    throw new GuestRefusal("That card's states are more than a card at this table can hold.");
  }
  return readableStateRows(raw);
}

const ACTIVATIONS: readonly CardActivation[] = ["active", "passive"];

function readGuestActivation(raw: unknown): CardActivation | undefined {
  if (raw === undefined) return undefined;
  if (!ACTIVATIONS.includes(raw as CardActivation)) throw new GuestRefusal("That is not a way a card can be in the prompt.");
  return raw as CardActivation;
}

/** A card's faces: each an id, words, and a picture that is the picture itself. */
function readGuestFaces(raw: unknown): Expression[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new GuestRefusal("A card's faces have to be a list.");
  return raw.map((face): Expression => {
    if (!face || typeof face !== "object") throw new GuestRefusal("A face on a card has to be a face.");
    const f = face as Record<string, unknown>;
    const transform = readGuestCrop(f.transform);
    return {
      id: readGuestName("face's id", f.id),
      ...(f.title === undefined ? {} : { title: readGuestText("face's name", f.title) }),
      description: readGuestText("face's description", f.description ?? ""),
      image: readGuestPicture(f.image),
      ...(transform ? { transform } : {}),
    };
  });
}

type FieldReader = (raw: unknown) => unknown;

/** The text rows of a field table a guest may write — every one but the model's instructions. */
function contentFields(rows: readonly CardField[]): Record<string, FieldReader> {
  return Object.fromEntries(rows.filter((row) => !row.instructs).map((row) => [row.key, optionalText(row.label.toLowerCase())]));
}

/** What either kind of card carries that is not text: its picture, its states, how it is admitted. */
const SHARED_FIELDS: Record<string, FieldReader> = {
  image: readGuestPicture,
  imageTransform: readGuestCrop,
  states: readGuestStates,
  activation: readGuestActivation,
};

/**
 * **Every field a guest may write, per kind, with the reader that makes it its type.**
 *
 * The text rows come from the one field table the editors and the card writer read
 * (`lib/cards/fields.ts`), so a field added there is writable here the day it exists and a row
 * marked `instructs` never is. What is not in this table does not reach the host's card at all:
 * the rows the host keeps (below), and the bookkeeping a manager's save carries — `isNew`, a
 * shelf's folder, an import's carried corners — which says nothing about the story.
 */
export const GUEST_CARD_FIELDS: Record<"character" | "world", Record<string, FieldReader>> = {
  character: {
    name: (raw) => readGuestName("name", raw),
    ...contentFields(CARD_FIELDS),
    ...SHARED_FIELDS,
    tags: (raw) => readGuestTextList("tags", raw, readGuestName),
    alternateGreetings: (raw) => readGuestTextList("alternate greetings", raw, readGuestText),
    expressions: readGuestFaces,
    // The lorebooks it owns, by id — what the world manager's Belongs to writes (`Character.lorebooks`).
    lorebooks: (raw) => readGuestTextList("lorebooks", raw, readGuestName),
    // The cast folder it is filed in, by id — the card's Folder select (`Character.folderId`). Filing
    // and nothing else: no prompt and no turn reads it. Out of one is the field gone.
    folderId: (raw) => (raw === undefined ? undefined : readGuestName("folder", raw)),
  },
  world: {
    title: (raw) => readGuestName("title", raw),
    ...contentFields(WORLD_FIELDS),
    ...SHARED_FIELDS,
    // The lorebook it is filed in, by id — the card's Lorebook select (`World.folderId`). Out of one
    // is the field gone, which a guest's save says by leaving it undefined.
    folderId: (raw) => (raw === undefined ? undefined : readGuestName("lorebook", raw)),
  },
};

/**
 * **What stays the host's on a card, and the words a guest is told it in.**
 *
 * - The rows the field table marks `instructs`: directions to the model, which on the narrator's
 *   card are the narrator's identity — a guest writing one was writing the system prompt of every
 *   request the host's key paid for.
 * - `retrievalKeys`: a key gates what the host's prompt admits, and one written `/as a pattern/`
 *   runs on the host's main thread against the conversation.
 * - `roleSetting`: who plays the card. Flipped to a player's, any card — the narrator's included —
 *   could be claimed, and the claimant then owned every line it had ever spoken, edit and delete
 *   rights and all.
 */
export const HOST_KEEPS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(CARD_FIELDS.filter((row) => row.instructs).map((row) => [row.key, row.label.toLowerCase()])),
  retrievalKeys: "retrieval keys",
  roleSetting: "who plays it",
};

/** The value `read` hands back, or the sentence it refused with. */
export function readOrRefusal<T>(read: () => T): { value: T } | { refused: string } {
  try {
    return { value: read() };
  } catch (err) {
    if (err instanceof GuestRefusal) return { refused: err.message };
    throw err;
  }
}
