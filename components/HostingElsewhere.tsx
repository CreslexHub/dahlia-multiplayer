"use client";

import { SignOutIcon } from "@phosphor-icons/react";
import { useRoomStore } from "../client/roomStore";
import { ui, app } from "@dahlia/plugin-api";

const { RoomIcon, ConfirmRow, useConfirmLatch, useModalBackdrop } = app.parts;
const { readChat } = app.story;
const { Button } = ui;

/**
 * **Hosting keeps the story you host — and says so, rather than taking you back to it.**
 *
 * The rule is the owner's and it stands (TURNS.md §21.2): while this tab hosts, the table follows
 * the story it hosts, and a host standing in another story is a room whose authority is somewhere
 * else with nothing on either screen saying so. What it used to *do* about that was a guard in
 * `PlayTogetherModal` that pushed the host back to the hosted chat the moment they opened another —
 * with no word. The owner, round 2026-10-06C: *"when I am hosting a chat, it keeps silently
 * returning me to the hosted chat. clarify this or remove this feature. the user will get confused
 * why they are getting teleported back."*
 *
 * So nobody is moved. Opening another chat while hosting finds a notice over it, naming the story
 * the table follows, with the two ways on: back to it, or end the session. The notice covers the
 * chat, so nothing in it can be written or generated while a table is bound elsewhere — the data
 * half already broadcasts only the bound chat. On any screen that is not a chat (home, settings), a
 * small "Hosting · <story>" pill stands at the top and takes the host back on a press.
 *
 * The host alone. A guest wandering off is reading somebody else's library and owns nothing; the
 * guest side is untouched.
 */
export function HostingElsewhere() {
  const hosting = useRoomStore((s) => s.phase === "lobby" && s.isHost);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  const activeChatId = app.story.chats.use((s) => s.activeChatId);
  const pathname = app.nav.usePath();
  const router = app.nav.useNavigate();

  if (!hosting || !boundChatId) return null;
  const onChat = pathname === "/chat";
  // On the hosted story itself, or a chat screen that has not opened a chat yet: nothing to say.
  const elsewhere = hosting && !!boundChatId && !(onChat && (activeChatId === null || activeChatId === boundChatId));
  const back = () => router.push(app.nav.chatPath(boundChatId));

  if (!elsewhere) return null;
  const story = readChat(boundChatId!)?.title?.trim() || "the story";

  if (!onChat) {
    return (
      <button
        type="button"
        onClick={back}
        title={`You're hosting “${story}”. Go back to it.`}
        className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-accent-400/50 bg-surface-200/95 px-3 py-1.5 text-2xs font-medium text-accent-400 shadow-md backdrop-blur-md transition-colors hover:bg-surface-300"
      >
        <RoomIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Hosting · {story}</span>
      </button>
    );
  }

  return <HostingNotice story={story} onBack={back} />;
}

/**
 * The notice over another chat. Its backdrop is the modals' own (`useModalBackdrop`), so Escape
 * answers it as it answers every dialog — by going back to the table, the one way on that keeps
 * the session — and it stands on the dialogs' layer. A stray press on the veil does nothing: the
 * other way on ends the session for everyone, and neither should be a misclick.
 */
function HostingNotice({ story, onBack }: { story: string; onBack: () => void }) {
  const latch = useConfirmLatch<HTMLDivElement>();
  const backdrop = useModalBackdrop({ onClose: onBack, backdrop: "bg-surface-100/80 backdrop-blur-sm", keepOnBackdropClick: true });
  return (
    <div {...backdrop} role="dialog" aria-modal="true" aria-labelledby="hosting-elsewhere-title">
      <div className="w-full max-w-sm rounded-xl border border-line-300 bg-surface-200 p-5 shadow-xl">
        <div className="flex items-center gap-2 text-accent-400">
          <RoomIcon className="h-5 w-5 shrink-0" />
          <h2 id="hosting-elsewhere-title" className="min-w-0 truncate text-sm font-semibold text-ink-500">
            You&apos;re hosting “{story}”
          </h2>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-300">
          The table stays on the story you&apos;re hosting. Go back to it, or end the session to use this chat.
        </p>
        <div ref={latch.ref} className="mt-4 flex flex-col gap-2">
          <Button variant="primary" className="w-full" onClick={onBack}>
            <span className="truncate">Back to “{story}”</span>
          </Button>
          {latch.armed ? (
            <ConfirmRow
              align="start"
              question="This ends the session for everyone at the table."
              confirmLabel="End the session"
              onConfirm={() => {
                latch.disarm();
                useRoomStore.getState().leaveRoom();
              }}
              onCancel={latch.disarm}
            />
          ) : (
            <Button variant="danger" className="w-full" onClick={latch.arm}>
              <SignOutIcon className="h-4 w-4" />
              End the session
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
