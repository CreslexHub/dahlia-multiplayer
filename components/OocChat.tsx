"use client";

import { useEffect, useRef, useState } from "react";
import { PaperPlaneTiltIcon, PaperclipIcon } from "@phosphor-icons/react";
import { useRoomStore, type OocMessage } from "../client/roomStore";
import { ui, app } from "@dahlia/plugin-api";
import type { Character, Message, MessageImage } from "@dahlia/plugin-api";

const { TABLE_TALK_LIMITS } = app.cards;
const { tableCharacterFor } = app.cast;
const { GLYPH, submitsOnEnter, ChatMessage, AttachmentStrip, useAttachments, useComposingRows } = app.parts;
const { readChat, draftsAt } = app.story;
const { IconButton, TextField } = ui;

/**
 * Table talk between the people at the table.
 *
 * Renders inside the Director pane's OOC tab, but an OOC line is not a director message —
 * not prose, not a proposal, and it must never reach a prompt (MULTIPLAYER.md §4). It
 * comes from `roomStore` and dies with the room, which is the whole of why this component
 * reads nothing from the chat's transcript.
 *
 * The rows *are* `ChatMessage`s: same bubbles, same avatar box, same timestamp format,
 * same grouping of consecutive lines — a hand-rolled row here was a second message UI
 * one pane away from the first, which is §13.1 with a coat of paint. Speakers resolve
 * through the seat-identity ladder (`tableCharacterFor`), so a person's portrait is the
 * same picture in the story and in the table talk.
 *
 * It is also where `at: "ooc"` comes from. This pane's draft is component state with no
 * store to subscribe to, so the report is made on change and the **stop** where the box
 * empties: on send, and on unmount — leaving this tab throws the draft away, and a promise
 * that outlives what it promised is the defect the told stop exists to close.
 */

/**
 * An OOC line dressed as the transcript's own shape, for the shared bubble. A picture takes
 * its id from its place: a line here is never edited, so the place is stable.
 */
function asMessage(line: OocMessage): Message {
  const images = (line.images ?? []).map((dataUrl, i) => ({ id: `${line.id}:${i}`, dataUrl }));
  return { id: line.id, role: "user", content: line.text, timestamp: line.at, ...(images.length > 0 ? { images } : {}) };
}

export function OocChat() {
  const ooc = useRoomStore((s) => s.ooc);
  const selfId = useRoomStore((s) => s.selfId);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  const sendOoc = useRoomStore((s) => s.sendOoc);
  const markOocRead = useRoomStore((s) => s.markOocRead);
  const appearance = app.story.chats.use((s) => s.activeChat?.chatSettings.appearance);
  // The story's rule, as every bubble is told it — the same object for the same settings, so no row re-renders for it.
  const reportTyping = useRoomStore((s) => s.reportTyping);
  const [draft, setDraft] = useState("");
  // Held beside the draft, in the same component state, for the same reason: table talk is
  // not the story's and does not go through the chat store. Offered whatever the Vision card
  // says — nothing here reads a picture, so there is no model to spare the cost.
  const [attachments, setAttachments] = useState<MessageImage[]>([]);
  const attach = useAttachments(attachments, setAttachments, () => TABLE_TALK_LIMITS);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Being on this tab is what "read" means — on arrival and on every message that lands
  // while the tab is showing, so the badge only ever counts what nobody was looking at.
  useEffect(() => {
    markOocRead();
  }, [ooc.length, markOocRead]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ooc.length]);

  // The one identity ladder (`seat-identity.ts`): claim, then minted card, then — for
  // the host — the chat's persona, so the host talks with the face they play with
  // instead of a blank avatar. One face per person across the story and the table talk.
  const claims = useRoomStore((s) => s.claims);
  const hostId = useRoomStore((s) => s.roster.find((p) => p.isHost)?.id);
  // The chat the *room* is playing, not the one on screen — read once for both readers
  // below. A reader who has opened another chat while a table runs elsewhere still sees the
  // table's faces here, which is the rule the pane already followed line by line.
  const roomChat = boundChatId ? readChat(boundChatId) : null;
  const speakerFor = (line: OocMessage): Character | null =>
    roomChat ? tableCharacterFor(roomChat, line.from, claims, line.from === hostId) : null;

  // The same table the story reads, filtered to this pane. A draft typed here is table talk
  // and belongs nowhere near the transcript, whatever the turn rules would allow.
  const ghosts = draftsAt(useComposingRows(roomChat ?? null), "ooc");

  // Table talk names the *person*, with the character they are playing in parentheses —
  // "Ana (Mira)". The account name is who said it; the parenthesis is who they are at
  // the table, and it goes away when the two are the same word.
  const displayName = (line: OocMessage, speaker: Character | null): string => {
    return speaker && speaker.name !== line.name ? `${line.name} (${speaker.name})` : line.name;
  };

  const send = () => {
    sendOoc(draft, attachments.map((image) => image.dataUrl));
    setDraft("");
    setAttachments([]);
    // The box is empty, so the promise is spent. Unthrottled by design: a stop two seconds
    // behind its own line is the defect this pane's receipt already worked around.
    reportTyping("", "ooc");
  };

  // ...and the same stop on the way out, because leaving the tab throws the draft away.
  useEffect(() => () => reportTyping("", "ooc"), [reportTyping]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3">
        {ooc.length === 0 && ghosts.length === 0 ? (
          <p className="py-6 text-center text-xs text-ink-200">
            Talk between players. None of this goes into the story.
          </p>
        ) : (
          <div className="space-y-1.5">
            {ooc.map((line, index) => {
              const speaker = speakerFor(line);
              const row = (
                <ChatMessage
                  key={line.id}
                  message={asMessage(line)}
                  readOnly
                  isUserPersona={line.from === selfId}
                  speakerName={displayName(line, speaker)}
                  speakerCharacter={speaker}
                  // Consecutive lines from one speaker read as one run, like the transcript.
                  isFirstInGroup={index === 0 || ooc[index - 1].from !== line.from}
                  appearance={appearance}
                />
              );
              // A line the room never took. Dimmed and said out loud, because it is otherwise
              // indistinguishable from one everybody read — and the sender is the only person
              // who can do anything about it.
              return line.undelivered ? (
                <div key={line.id} data-ooc-undelivered={line.id} className="opacity-60">
                  {row}
                  <p className="px-2 pt-0.5 text-3xs text-rose-600 dark:text-rose-400">
                    Not sent. No one at the table saw this.
                  </p>
                </div>
              ) : (
                row
              );
            })}
            {/* At the end, where the line will go — the same rule the transcript follows,
                and the same drawing, so a promise reads the same way in both panes. */}
            {ghosts.map((row) => (
              <div
                key={row.key}
                data-composing-ghost={row.key}
                aria-label={`${row.name} is writing`}
                className="w-full flex justify-start"
              >
                <ChatMessage
                  message={{
                    id: `typing-${row.key}`,
                    role: "assistant",
                    content: row.preview ?? "",
                    timestamp: 0,
                    speakerCharacterId: row.character?.id,
                  }}
                  turnId={`typing-${row.key}`}
                  speakerCharacter={row.character}
                  speakerName={row.label}
                  isUserPersona={false}
                  isFirstInGroup={true}
                  groupSize={1}
                  indexInGroup={0}
                  contentOverride={row.preview ?? ""}
                  readOnly={true}
                  isStreamingTurn={true}
                  appearance={appearance}
                  animation={{ enableTypingIndicator: true } as never}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-line-300 p-3">
        <AttachmentStrip className="mb-1.5" images={attachments} onRemove={attach.remove} />
        <div className="flex items-end gap-2">
          <IconButton label="Attach a picture" onClick={attach.pick}>
            <PaperclipIcon className={GLYPH.md} />
          </IconButton>
          <TextField
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              reportTyping(e.target.value, "ooc");
            }}
            onKeyDown={(e) => {
              if (submitsOnEnter(e)) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={attach.onPaste}
            placeholder="Say something to the other players…"
            aria-label="OOC message"
          />
          <IconButton label="Send OOC message" variant="primary" onClick={send} disabled={!draft.trim() && attachments.length === 0}>
            <PaperPlaneTiltIcon className={GLYPH.md} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
