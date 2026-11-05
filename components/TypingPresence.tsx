"use client";
import { app } from "@dahlia/plugin-api";
import type { ComposingRow, Chat } from "@dahlia/plugin-api";

const { MessageAvatar, TypingWorm, chipAvatarBox, useResolvedAppearance, useComposingRows } = app.parts;
const { draftsAt } = app.story;


/**
 * "Bo is typing…" — the players whose draft has **nowhere to stand in the story**.
 *
 * It used to be everybody with their fingers on the keys. A draft that the turn rules would
 * let land is drawn in the transcript now, where the line itself will appear, so what is
 * left here is exactly the case the story has no honest place for: somebody typing out of
 * turn under a rigid loop, a spent wave, a closed window. The fingers are real; the promise
 * a bubble in the story would make is one the host is going to break.
 *
 * Which of the two it is, is `place` — decided once in `composingRows` and never here, so
 * "drawn on two surfaces at once" is unrepresentable rather than avoided by convention.
 */

/** The line under the faces. Named because a list of names reads differently at each length. */
function typingLine(rows: ComposingRow[]): string {
  if (rows.length === 1) {
    return rows[0].preview ? `${rows[0].name}: ${rows[0].preview}` : `${rows[0].name} is typing…`;
  }
  if (rows.length === 2) return `${rows[0].name} and ${rows[1].name} are typing…`;
  return `${rows.length} players are typing…`;
}

export function TypingPresence({ chat }: { chat: Chat }) {
  const rows = draftsAt(useComposingRows(chat), "room");
  // Above the early return: a hook asked on some renders and not others is React's error.
  const appearance = useResolvedAppearance(chat.chatSettings.appearance);
  if (rows.length === 0) return null;

  const box = chipAvatarBox(appearance);
  return (
    // A pill of its own, as the transcript's floating Continue is: it stands over the story's foot
    // in the composer's tray (`ComposerTray`), and bare words there would sit on the story's.
    <div className="flex max-w-full items-center gap-2 rounded-full border border-line-300 bg-surface-200/90 py-0.5 pl-1 pr-2.5 text-2xs text-ink-300 shadow-sm backdrop-blur" aria-live="polite">
      <span className="flex -space-x-2">
        {rows.slice(0, 3).map((row) => (
          <span
            key={row.key}
            className="block h-5 w-5 overflow-hidden rounded-full ring-1 ring-surface-200"
            title={row.name}
          >
            <MessageAvatar speakerCharacter={row.character} speakerName={row.label} box={box} />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{typingLine(rows)}</span>
      {/* The canonical typing worm, wherever the app says somebody has their fingers on the keys. */}
      <TypingWorm className="scale-75 origin-left" />
    </div>
  );
}
