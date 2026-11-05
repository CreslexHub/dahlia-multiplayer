import { app } from "@dahlia/plugin-api";
import type { Chat, HiddenInjection, Message, MessageAction } from "@dahlia/plugin-api";

const { playerCharacterId, claimedCharacterFor } = app.cast;

/**
 * What a guest may do to the shared story — one labelled table, two readers.
 *
 * The settings surface renders its rows; the host's intent handlers enforce them. Never
 * a switch in each (AGENTS §13.1): a right that exists in the UI but not in the handler
 * is a button that lies, and one that exists in the handler but not the UI is a rule
 * nobody can see. A guest's own screen also *asks* before offering a control — but the
 * host's check is the one that grants, because a guest UI showing a button is never the
 * thing that confers the right.
 *
 * Session state, not `ChatSettings` (MULTIPLAYER.md §2.2): rights over a live table die
 * with the table.
 */


/**
 * Four of these rights are a *verb* applied to a *scope*, and drawing them as four full-width
 * toggle rows said the same thing four times over in prose nobody reads.
 *
 * `action` and `scope` are the axes; `permissionLayout()` derives the grid. A right with no
 * verb falls out as its own row rather than as a blank cell, which is the point of deriving
 * it: a hand-drawn 2×2 would have to be edited to stay true, and would not be.
 */
export const GUEST_PERMISSION_ROWS = [
  {
    id: "editOwnLines",
    label: "Edit their own lines",
    sub: "A player may rewrite what their character said.",
    grantedByDefault: true,
    action: "edit",
    scope: "own",
  },
  {
    id: "deleteOwnLines",
    label: "Delete their own lines",
    sub: "A player may take back what their character said.",
    grantedByDefault: true,
    action: "delete",
    scope: "own",
  },
  {
    id: "editAnyLine",
    label: "Edit anyone's lines",
    sub: "Including the narrator's and other players'.",
    grantedByDefault: false,
    action: "edit",
    scope: "any",
  },
  {
    id: "deleteAnyLine",
    label: "Delete anyone's lines",
    sub: "Including the narrator's and other players'.",
    grantedByDefault: false,
    action: "delete",
    scope: "any",
  },
  {
    id: "approveProposals",
    label: "Approve Director proposals",
    sub: "Guests can approve or reject the Director's proposed changes.",
    grantedByDefault: false,
  },
  {
    id: "editLibrary",
    label: "Edit characters & worlds",
    sub: "Off: guests can view the character and world managers but not edit them.",
    grantedByDefault: true,
  },
  {
    id: "writeNotes",
    label: "Write Director's notes",
    sub: "Guests can steer the scene with hidden notes of their own.",
    // Off, like approvals: a note is an instruction to a model running on the host's keys,
    // in the host's story. The composer refused guests outright before this row existed —
    // with a toast, after they had typed the note — so the default is what shipped.
    grantedByDefault: false,
  },
  {
    id: "stopReplies",
    label: "Stop a reply being written",
    sub: "A guest's Stop ends the reply and drops what they hadn't read yet.",
    /**
     * **The whole answer to a guest's Stop**, apart from there being something to stop.
     *
     * It was answered by the turn rules — a guest who could not have spoken out of turn could
     * not stop either — which was a gate no screen showed and no host could change: at a mic
     * table the one control that ends a reply running on the host's keys was simply dead in a
     * guest's hand. The owner's ruling (`.agents/history/SWEEP.md` §2.5) was a row of its own.
     *
     * On, because it is what a table in live mode — the default — has always let every guest do,
     * and because a Stop spends nothing: it ends a request on the host's keys rather than
     * starting one, and throws away only text the guest had not read. The two rights that ship
     * off are the two that *spend* on the host's model (a note) or change the story for everyone
     * (an approval).
     */
    grantedByDefault: true,
  },
] as const;

/** The verbs and the scopes, in the order the matrix draws them. */
export const PERMISSION_ACTIONS = [
  { id: "edit", label: "Edit" },
  { id: "delete", label: "Delete" },
] as const;

export const PERMISSION_SCOPES = [
  { id: "own", label: "Their own lines", accent: "violet" },
  // Amber, because this is the dangerous one and the drawing should say so before the prose
  // does — it is the row that lets a guest rewrite the narrator.
  { id: "any", label: "Anyone's lines", accent: "amber" },
] as const;

/**
 * The matrix, and whatever will not fit in it.
 *
 * Derived from the rows above rather than written out, so the screen cannot describe a right
 * the table does not have, and a right the table gains cannot go undrawn.
 */
export function permissionLayout(): {
  grid: { scope: (typeof PERMISSION_SCOPES)[number]; cells: (GuestPermissionId | null)[] }[];
  rest: (typeof GUEST_PERMISSION_ROWS)[number][];
} {
  const gridded = new Set<string>();
  const grid = PERMISSION_SCOPES.map((scope) => ({
    scope,
    cells: PERMISSION_ACTIONS.map((action) => {
      const row = GUEST_PERMISSION_ROWS.find(
        (r) => "action" in r && r.action === action.id && r.scope === scope.id
      );
      if (row) gridded.add(row.id);
      return (row?.id ?? null) as GuestPermissionId | null;
    }),
  }));
  return { grid, rest: GUEST_PERMISSION_ROWS.filter((r) => !gridded.has(r.id)) };
}

/**
 * Is this right already granted by a broader one?
 *
 * "Anyone's lines" implies "their own", and `guestMayActOnMessage` ORs the pair — so *own
 * off, anyone on* is representable and behaves as though both were on. The matrix draws that
 * cell on-and-disabled, and it reads this rather than restating the implication, because a
 * drawing that states the rule from a second copy of it is clever rather than honest.
 */
export function permissionCoveredBy(
  id: GuestPermissionId,
  permissions: GuestPermissions
): boolean {
  const row = GUEST_PERMISSION_ROWS.find((r) => r.id === id);
  if (!row || !("scope" in row) || row.scope !== "own") return false;
  const broader = GUEST_PERMISSION_ROWS.find(
    (r) => "action" in r && r.action === row.action && r.scope === "any"
  );
  return !!broader && permissions[broader.id];
}

export type GuestPermissionId = (typeof GUEST_PERMISSION_ROWS)[number]["id"];
export type GuestPermissions = Record<GuestPermissionId, boolean>;

/** Derived from the table — a new row cannot be forgotten here. */
export const DEFAULT_GUEST_PERMISSIONS: GuestPermissions = Object.fromEntries(
  GUEST_PERMISSION_ROWS.map((row) => [row.id, row.grantedByDefault])
) as GuestPermissions;

/**
 * Is this character the one this account is playing — the card they claimed, or the card
 * minted for them?
 *
 * The one answer to "who am I at this table", asked by everything that has to decide whether
 * something is *yours*: a line you may edit, a note addressed to you. Their table identity
 * may have changed since a line was written, which is why the minted id is always theirs.
 */
export function playsCharacter(
  chat: Chat,
  ownerId: string,
  claims: Record<string, string>,
  characterId: string | null | undefined
): boolean {
  if (!characterId) return false;
  // The minted card is theirs unconditionally: it is named after the account, nobody else can
  // be wearing it, and a line written as it stays theirs however the table has moved on.
  if (characterId === playerCharacterId(ownerId)) return true;
  /**
   * The claim is asked of `claimedCharacterFor`, which re-validates it against the chat.
   *
   * This used to be a bare `characterId === claims[ownerId]`, and `claims` is cleaned only
   * when a player leaves — never when the character they claimed is deleted or has its role
   * flipped back to AI. So the two readers of "who does this guest play" disagreed: speaking
   * went through `claimedCharacterFor` and was safe, while *ownership* went through here and
   * was not. Flip a claimed cast card to an AI role — which any guest can do, since
   * `editLibrary` is granted by default and only minted cards are shielded — and the claimant
   * silently owned every line the Writer went on to write as that character, with edit and
   * delete under the default own-line rights.
   */
  return claimedCharacterFor(chat, ownerId, claims)?.id === characterId;
}

/** Whether this message is the player's own words — `playsCharacter`, of whoever spoke it. */
export function ownsMessage(
  chat: Chat,
  ownerId: string,
  claims: Record<string, string>,
  message: Pick<Message, "speakerCharacterId">
): boolean {
  return playsCharacter(chat, ownerId, claims, message.speakerCharacterId);
}

/**
 * **Who at the table may read a Director's note.**
 *
 * A note is a *hidden* injection — hidden from the story — and it was not hidden from the
 * room at all: the host's private steering rode the snapshot to every screen, which is a
 * spoiler machine in a story the host is running for other people.
 *
 * Three answers, and the middle one is the default for that reason. It is not the widest:
 * it is the reading that matches what a note is.
 */
export const NOTE_VISIBILITY_ROWS = [
  { id: "everyone", label: "Everyone" },
  { id: "addressed", label: "Who it's for" },
  { id: "host", label: "You only" },
] as const;

export type NoteVisibility = (typeof NOTE_VISIBILITY_ROWS)[number]["id"];
export const DEFAULT_NOTE_VISIBILITY: NoteVisibility = "addressed";

/**
 * What stands where a note somebody may not read would have been.
 *
 * **Sealed is the default**, and the reason is not drama: a card that silently disappears
 * from one screen while it sits on another makes two transcripts that disagree about how
 * many things are in them, which is the hardest kind of divergence to see and to report. A
 * seal keeps the two structurally identical and says, honestly, that there is something
 * here. A host who does not want the table to know they are steering picks the other one.
 */
export const NOTE_SEAL_ROWS = [
  { id: "sealed", label: "A sealed card" },
  { id: "hidden", label: "Nothing at all" },
] as const;

export type NoteSeal = (typeof NOTE_SEAL_ROWS)[number]["id"];
export const DEFAULT_NOTE_SEAL: NoteSeal = "sealed";

/**
 * Whether one account may read one note.
 *
 * **Your own note is always yours**, ahead of every policy — a person who cannot read what
 * they just wrote has been handed a broken app, not a rule. Then the policy: everyone reads
 * everything; or a note reaches the player of the character it names (and an *unaddressed*
 * note is everybody's, because that is what addressing nobody means); or nobody but the host.
 *
 * A note addressed to a card no player is holding — the usual case, since most notes steer
 * the cast — is the host's alone under "who it's for", which is what it should be: it is a
 * direction for a model, not a message to a person.
 */
export function mayReadNote(
  note: Pick<HiddenInjection, "targetCharacterId" | "authorOwnerId">,
  opts: { chat: Chat; ownerId: string; claims: Record<string, string>; visibility: NoteVisibility }
): boolean {
  if (note.authorOwnerId === opts.ownerId) return true;
  if (opts.visibility === "everyone") return true;
  if (opts.visibility === "host") return false;
  if (!note.targetCharacterId) return true;
  return playsCharacter(opts.chat, opts.ownerId, opts.claims, note.targetCharacterId);
}

/**
 * One note, as one guest is allowed to receive it: the note, a seal, or nothing.
 *
 * **The text does not go out.** Sealing on the host — where the snapshot leaves — rather
 * than hiding on the guest is the whole of the feature being real: a note redacted by the
 * screen that draws it is a note anybody can read out of the console, and "censored" would
 * be a promise the wire breaks.
 *
 * What survives a seal is who it is for and how long it lasts, which is what makes a seal
 * worth drawing at all. A host who does not want the table to know that Ana is being steered
 * chooses "Nothing at all" instead.
 */
export function noteForGuest(
  note: HiddenInjection,
  opts: {
    chat: Chat;
    ownerId: string;
    claims: Record<string, string>;
    visibility: NoteVisibility;
    seal: NoteSeal;
  }
): HiddenInjection | null {
  if (mayReadNote(note, opts)) return note;
  return opts.seal === "sealed" ? { ...note, content: "", sealed: true } : null;
}

/**
 * The one answer to "may this guest do this to this message". Asked twice on purpose —
 * by the guest's screen before offering the control, and by the host before applying
 * the intent — and it must be the same function both times or the button and the rule
 * drift apart.
 */
export function guestMayActOnMessage(
  action: MessageAction,
  opts: {
    chat: Chat;
    ownerId: string;
    claims: Record<string, string>;
    permissions: GuestPermissions;
    message: Pick<Message, "speakerCharacterId">;
  }
): boolean {
  const own = ownsMessage(opts.chat, opts.ownerId, opts.claims, opts.message);
  const p = opts.permissions;
  // The ORs are the implication the matrix draws: "anyone's lines" covers "their own".
  // `permissionCoveredBy` states it once so the picture and the rule cannot disagree.
  if (action === "edit") return own ? p.editOwnLines || p.editAnyLine : p.editAnyLine;
  return own ? p.deleteOwnLines || p.deleteAnyLine : p.deleteAnyLine;
}
