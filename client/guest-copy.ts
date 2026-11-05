import { noteForGuest, mayReadNote, type NoteSeal, type NoteVisibility } from "./permissions";
import { app } from "@dahlia/plugin-api";
import type { DirectorTagSpan, ScannedCall, ProposalAction, Chat, HiddenInjection, NoteDirection } from "@dahlia/plugin-api";

const { parseDirectorTagSpans, TOOL_SPECS, namesOf, scanToolCalls } = app.cards;

/**
 * **The story as one guest may receive it — every copy of a secret taken out, not one.**
 *
 * Two facts are the host's and nobody else's at a table: **the Director's notebook** (its
 * `secrets` block is by name what the players do not know, and the rest is the host's private
 * steering), and **a Director's note** this guest may not read under the table's visibility
 * policy (`mayReadNote`).
 *
 * This used to be two field edits — drop `chat.notebook`, seal `hiddenInjections` — and the
 * same words rode the snapshot five other ways: the Director's reply as it wrote it
 * (`<notebook_set block="secrets">…` verbatim), each call's `rawTag` on its timeline, the undo
 * record a notebook write files (the block before and after it), the Director's run filed on
 * the narration it reviewed, and the note's own proposal payload. A host who chose "You only"
 * was one console away from a table reading the secrets block.
 *
 * So this is keyed by the fact, not the field. It finds the secrets from the records that
 * *are* them — the notebook, its undo records, the notes, the proposals, and every
 * notebook/note call written anywhere in the chat — and then takes them out of everything:
 *
 * - **a call is removed where it is written**, wherever that is, by the parser's own spans
 *   (so a JSON-format call, whose body is escaped and would not match its own text, goes too);
 * - **the agents' own records** (`AGENT_RECORDS`) lose every verbatim occurrence of a secret —
 *   the reasoning that quotes the block it is about to write, a refusal that quotes the tag;
 * - **a notebook write's undo record** loses the block it holds, and **a secret proposal**
 *   loses its words, structurally.
 *
 * Why the verbatim scrub stops at the agents' records: the story and the cards are text a guest
 * may *edit* and send back. A note that happens to repeat a sentence of Ana's description would
 * otherwise come back from a guest's edit with that sentence missing from the host's card.
 *
 * What it cannot do is un-say a paraphrase: a Director's reasoning that describes the secret in
 * other words is still reasoning. Whether a guest should see the Director's reasoning at all is
 * the host's question, not a redaction's.
 */
export type GuestReader = {
  ownerId: string;
  claims: Record<string, string>;
  visibility: NoteVisibility;
  seal: NoteSeal;
};

/**
 * Where an agent keeps its own words about the story, as opposed to the story. Every string
 * under one of these keys is scrubbed of a secret's words wherever they occur in it.
 */
const AGENT_RECORDS: ReadonlySet<string> = new Set([
  "directorMessages",
  "directorSummaries",
  "proposalBundles",
  "runs",
  "stateChanges",
] satisfies (keyof Chat | "runs" | "stateChanges")[]);

/**
 * The two kinds of call whose words may be secret, by the event or action they build — and the
 * names they may be written under, read off the tool table, so a string that names neither is
 * never parsed at all (the prefilter is the cost of scrubbing a long chat per guest).
 */
const NOTEBOOK_WRITE = "notebook_set";
const NOTE = "inject";
/** Every tag that builds a notebook write — `<notebook_set>` and `<notebook_remove>` — by the event it builds. */
const NOTEBOOK_PERMISSION = "notebook";
const SECRET_TOOLS = TOOL_SPECS.filter((s) => s.permission === NOTEBOOK_PERMISSION || s.name === NOTE);
const SECRET_TOOL_NAMES: readonly string[] = SECRET_TOOLS.flatMap(namesOf);

export function chatForGuest(chat: Chat, reader: GuestReader): Chat {
  const opts = { chat, ...reader };
  const notes = chat.hiddenInjections ?? [];
  const allowed = notes
    .map((note) => noteForGuest(note, opts))
    .filter((note): note is HiddenInjection => note !== null);
  const notesUntouched = allowed.length === notes.length && allowed.every((n, i) => n === notes[i]);

  const readsNote = (note: Pick<HiddenInjection, "targetCharacterId" | "authorOwnerId">): boolean =>
    mayReadNote(note, opts);
  const filed = new Map(notes.map((n) => [n.id, n]));
  /** A proposed note is readable as its filed note is, or — not filed yet — as its payload says. */
  const readsAction = (action: ProposalAction): boolean => {
    const note = filed.get(action.id);
    if (note) return readsNote(note);
    return readsNote(action.payload as NoteDirection);
  };
  const secretSpan = (span: DirectorTagSpan): boolean =>
    (span.kind === "event" && span.value.type === NOTEBOOK_WRITE) ||
    (span.kind === "action" && span.value.type === NOTE && !readsNote(span.value));

  // ── What is secret: the words themselves, gathered from every record that holds them ──
  const secrets = new Set<string>();
  const keep = (text: unknown) => {
    if (typeof text === "string" && text.trim()) secrets.add(text.trim());
  };
  // The sections' words, never their names: a name ("Plan") is a word the story uses too, and
  // scrubbing it out of every record would take it out of the guest's transcript.
  for (const section of chat.notebook ?? []) keep(section.text);
  for (const note of notes) if (!readsNote(note)) keep(note.content);

  walk(chat, (node) => {
    if (typeof node === "string") {
      for (const span of spansIn(node)) {
        if (!secretSpan(span)) continue;
        if (span.kind === "event" && span.value.type === NOTEBOOK_WRITE) keep(span.value.text);
        if (span.kind === "action" && span.value.type === NOTE) keep(span.value.content);
      }
      for (const { call } of refusedIn(node)) keep(call.body);
      return;
    }
    if (isNotebookChange(node)) {
      keep((node.previousValue as { section?: { text?: unknown } } | null | undefined)?.section?.text);
      keep((node.appliedValue as { text?: unknown } | null | undefined)?.text);
    } else if (isProposalAction(node)) {
      const secret = secretAction(node, readsAction);
      if (secret) keep(secret.words);
    }
  });

  if (secrets.size === 0 && notesUntouched && !chat.notebook) return chat;

  // Longest first, so a secret that contains another is taken out whole.
  const words = [...secrets].sort((a, b) => b.length - a.length);
  const scrub = (text: string): string => {
    let out = text;
    for (const w of words) if (out.includes(w)) out = out.split(w).join("");
    return out;
  };
  const withoutCalls = (text: string): string => {
    const cut = [...spansIn(text).filter(secretSpan), ...refusedIn(text).map(({ call }) => call)];
    if (cut.length === 0) return text;
    let out = text;
    for (const span of [...cut].sort((a, b) => b.index - a.index)) {
      out = out.slice(0, span.index) + out.slice(span.index + span.raw.length);
    }
    return out;
  };

  const clean = (node: unknown, inRecords: boolean): unknown => {
    if (typeof node === "string") {
      const cut = withoutCalls(node);
      return inRecords && words.length > 0 ? scrub(cut) : cut;
    }
    if (Array.isArray(node)) return shareArray(node, (item) => clean(item, inRecords));
    if (!node || typeof node !== "object") return node;
    if (isNotebookChange(node)) {
      const { previousValue: _before, appliedValue: _after, ...rest } = node;
      return shareObject(rest as Record<string, unknown>, (value) => clean(value, true));
    }
    if (isProposalAction(node)) {
      const secret = secretAction(node, readsAction);
      if (secret) {
        const redacted = { ...node, payload: { ...(node.payload as object), [secret.field]: "" } };
        return shareObject(redacted as Record<string, unknown>, (value) => clean(value, true));
      }
    }
    return shareObject(node as Record<string, unknown>, (value, key) =>
      clean(value, inRecords || AGENT_RECORDS.has(key))
    );
  };

  const { notebook: _notebook, hiddenInjections: _notes, ...rest } = chat;
  const cleaned = clean(rest, false) as Omit<Chat, "notebook" | "hiddenInjections">;
  return { ...cleaned, hiddenInjections: notesUntouched ? notes : allowed };
}

// ─── The shapes it recognises ──────────────────────────────────────────────────────────────

type NotebookChange = { type: typeof NOTEBOOK_WRITE; entityId: string; previousValue?: unknown; appliedValue?: unknown };

/** A notebook write's undo record: the section before it, and the section it left. */
function isNotebookChange(node: unknown): node is NotebookChange {
  return !!node && typeof node === "object" && (node as { type?: unknown }).type === NOTEBOOK_WRITE && "entityId" in node;
}

function isProposalAction(node: unknown): node is ProposalAction {
  return (
    !!node &&
    typeof node === "object" &&
    typeof (node as { id?: unknown }).id === "string" &&
    typeof (node as { type?: unknown }).type === "string" &&
    "payload" in node
  );
}

/** Which of an action's fields holds a secret's words, and the words — or `null`. */
function secretAction(action: ProposalAction, readsAction: (a: ProposalAction) => boolean): { field: string; words: unknown } | null {
  const payload = action.payload as Record<string, unknown> | null | undefined;
  if (!payload) return null;
  if (action.type === "state_event" && payload.type === NOTEBOOK_WRITE) return { field: "text", words: payload.text };
  if (action.type === "injection" && !readsAction(action)) return { field: "content", words: payload.content };
  return null;
}

function spansIn(text: string): DirectorTagSpan[] {
  if (!SECRET_TOOL_NAMES.some((name) => text.includes(name))) return [];
  return parseDirectorTagSpans(text);
}

/**
 * **A secret tool's call that was refused** for an attribute it does not take (`ToolScan.refused`).
 * Never built, so it is in no span above, and whom a note was for is not known: it is cut whole and
 * its words kept secret, or a mistyped `<notebook_set>` put the Director's plan in a guest's copy.
 */
function refusedIn(text: string): ScannedCall[] {
  if (!SECRET_TOOL_NAMES.some((name) => text.includes(name))) return [];
  return scanToolCalls(text).refused.filter(({ spec }) => SECRET_TOOLS.includes(spec));
}

// ─── A walk that shares what it did not change ─────────────────────────────────────────────

function walk(node: unknown, visit: (node: unknown) => void): void {
  visit(node);
  if (Array.isArray(node)) for (const item of node) walk(item, visit);
  else if (node && typeof node === "object") for (const value of Object.values(node)) walk(value, visit);
}

/** The same array when no item changed — so a guest's copy of an untouched transcript is the host's. */
function shareArray(items: unknown[], map: (item: unknown) => unknown): unknown[] {
  let out: unknown[] | null = null;
  items.forEach((item, i) => {
    const next = map(item);
    if (next !== item && !out) out = items.slice(0, i);
    if (out) out.push(next);
  });
  return out ?? items;
}

function shareObject(node: Record<string, unknown>, map: (value: unknown, key: string) => unknown): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(node)) {
    const next = map(value, key);
    if (next !== value) {
      out ??= { ...node };
      out[key] = next;
    }
  }
  return out ?? node;
}
