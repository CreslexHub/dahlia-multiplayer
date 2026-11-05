"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRoomStore } from "../client/roomStore";
import { ROOM_CODE_LENGTH } from "../shared/protocol";
import { ROOM_ENDED_COPY } from "../client/endings";
import { ui, app } from "@dahlia/plugin-api";

const { PlayerNameEditor, useStoredPlayerName, SignInLink, useSignInOffer } = app.parts;
const { Button, Label, TextField } = ui;

/**
 * Where a link a friend sent you lands.
 *
 * This is the whole of what a guest needs, and it replaces a login screen that asked them to
 * make an account on somebody else's computer before they could sit down. A room code is the
 * credential now (`.agents/ACCESS.md` §3) — six characters, said out loud or clicked through —
 * and the only other thing the table wants to know is what to call you.
 *
 * It is also the page the public door redirects to. Somebody who found the tunnel URL and asked
 * for something that is not theirs is told, in effect, "this address is for joining a table",
 * which is true and is the only thing about the machine behind it they are going to learn.
 */

function JoinForm() {
  const params = app.nav.useQuery();
  const router = app.nav.useNavigate();
  const { name, save } = useStoredPlayerName();

  // The code may arrive three ways: in the link, typed, or pasted as a whole URL. All three
  // end up in this one field, because `parseRoomJoinInput` already knows how to read a URL and
  // a second parser here would be the second one to be taught about a new link shape.
  const [code, setCode] = useState(params.get("code")?.toUpperCase() ?? "");
  const [tried, setTried] = useState(false);

  const phase = useRoomStore((s) => s.phase);
  const error = useRoomStore((s) => s.error);
  const endedReason = useRoomStore((s) => s.endedReason);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  const joinRoom = useRoomStore((s) => s.joinRoom);

  /**
   * Walking in, once the host's snapshot has bound a story to this seat.
   *
   * A ref rather than a state flag so a re-render cannot walk somebody back in after they have
   * left for the library — the same guard, and the same reason, as the one in
   * `PlayTogetherModal`.
   */
  const walkedInto = useRef<string | null>(null);
  useEffect(() => {
    if (phase === "lobby" && boundChatId && walkedInto.current !== boundChatId) {
      walkedInto.current = boundChatId;
      router.push(app.nav.chatPath(boundChatId));
    }
  }, [phase, boundChatId, router]);

  // The way into the library from a device on the network — see `useSignInOffer`.
  const signIn = useSignInOffer();

  const joining = phase === "connecting" || (phase === "lobby" && !boundChatId);
  const ready = code.trim().length >= ROOM_CODE_LENGTH;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || joining) return;
    setTried(true);
    void joinRoom(code.trim());
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-surface-100 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <header className="space-y-1 text-center">
          <h1 className="text-xl font-bold text-ink-700">Join a table</h1>
          <p className="text-xs leading-relaxed text-ink-200">
            Enter the six-character code the host sent you. No account needed. The code stops
            working when the table closes.
          </p>
        </header>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="join-code">Room code</Label>
            <TextField
              id="join-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCDEF"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              className="font-mono tracking-widest"
              required
            />
            <p className="mt-1 text-2xs text-ink-200">A whole invite link works here too.</p>
          </div>

          <div>
            <Label htmlFor="join-name">You are</Label>
            {/* The profile's own editor, so the name at this table is the name everywhere —
                a second field here would be a second answer to what you are called. */}
            <PlayerNameEditor
              name={name}
              save={save}
              as="span"
              textClass="text-sm font-medium text-ink-600"
            />
          </div>

          {/* The refusal's own sentence, from the table the lobby reads. This printed one
              "that code doesn't name a table" for every refusal, so a guest turned away from a
              full room went back to the host for a new code that would be refused the same way. */}
          {tried && (error || endedReason) && (
            <p role="alert" className="rounded-lg bg-red-950/40 px-3 py-2 text-2xs leading-relaxed text-red-600 dark:text-red-300">
              {error ?? (endedReason && ROOM_ENDED_COPY[endedReason].copy)}
            </p>
          )}

          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!ready || joining}>
            {joining ? "Joining…" : "Join"}
          </Button>
        </form>

        {signIn && (
          <p className="text-center">
            <SignInLink href={signIn} />
          </p>
        )}
      </div>
    </main>
  );
}

/** The join page's body: the plugin's own page (`JOIN_PAGE`), drawn while it is loaded. */
export function JoinPage() {
  // `useSearchParams` suspends during prerender; the fallback is the page's own background so
  // the boundary is not a flash of a different colour.
  return (
    <Suspense fallback={<main className="min-h-[100dvh] bg-surface-100" />}>
      <JoinForm />
    </Suspense>
  );
}
