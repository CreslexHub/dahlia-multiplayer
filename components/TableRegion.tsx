"use client";

import React from "react";
import { ArmchairIcon } from "@phosphor-icons/react";
import { SeatRow } from "./SeatRow";
import { useTableState } from "./useTableState";
import { CONTINUE_POLICY_ROWS, useRoomStore } from "../client/roomStore";
import { ui, app } from "@dahlia/plugin-api";
import type { Chat } from "@dahlia/plugin-api";

const { RoomIcon, Surface, TYPE } = app.parts;
const { Label, Segmented, Hint, Section, SettingToggle } = ui;

/**
 * **The table** — the room, and who is sitting where. What guests may do at it is on Autonomy
 * (`GuestRightsSection`), with everything else about what may happen without you.
 *
 * This is what is left of the Multiplayer tab once the turn rules have moved out of it. The
 * split is identity: the rules name nobody, so they are chat settings and live above this in
 * "Voices and turns"; **the room and the seats name people**, so they are live
 * session state, they write through `roomStore`'s host-only actions, and they die with the
 * table. That is why they render here as a *region* rather than a screen — a chat's style is
 * readable with no room live, and the tab that held these refused to draw anything at all
 * without one, which is what put the turn rules out of reach until it was too late to plan
 * them.
 *
 * The divider carries the live status inline. A naive merge would have made the tab's
 * two-paragraph "no room is live" takeover blank every Chat style control whenever nobody was
 * hosting.
 *
 * §T1 stays in `roomStore` and renders disabled with no room, honestly: `connectTo` does
 * `set({ ...AT_REST })`, so an edit made before hosting is destroyed by the act of hosting.
 */
export function TableRegion({ chat }: { chat: Chat | null }) {
  const { drawn, locked, status } = useTableState(chat);
  const roster = useRoomStore((s) => s.roster);
  const enableAI = useRoomStore((s) => s.enableAI);
  const liveTyping = useRoomStore((s) => s.liveTyping);
  const continuePolicy = useRoomStore((s) => s.continuePolicy);
  const isHost = useRoomStore((s) => s.isHost);
  const setEnableAI = useRoomStore((s) => s.setEnableAI);
  const setLiveTyping = useRoomStore((s) => s.setLiveTyping);
  const setContinuePolicy = useRoomStore((s) => s.setContinuePolicy);

  // Drawn exactly where the Multiplayer tab's `visible` predicate drew that tab (`useTableState`).
  if (!chat || !drawn) return null;

  return (
    // A **recessed surface**, not a heading with a rule under it.
    //
    // It was the rule, and a reader could not tell where the story's own settings stopped:
    // its sections drawn exactly like the four above them, on the same ground, under a
    // hairline that reads as a divider between peers rather than a change of subject. Everything
    // in here names *people* and dies with the room; everything above is the chat's, and keeps.
    // That is a difference worth seeing before reading a single label — so the region steps
    // back a shade, which is this repo's rule for separating two surfaces (`Surface`: by shade,
    // not by line), and says what it is with an icon rather than another sentence.
    <Surface
      elevation="sunken"
      radius="xl"
      padding="md"
      className="mt-2 space-y-6 ring-1 ring-inset ring-line-200"
    >
      <div className="flex items-center gap-2">
        <RoomIcon className="h-4 w-4 shrink-0 text-accent-400" />
        <span className={TYPE.sectionHeading}>The table</span>
        <span className="h-px flex-1 bg-line-300" />
        <span className={TYPE.hint}>{status}</span>
      </div>
      {/* No preamble: the recessed surface, the icon and the live status line already say
          all three of its clauses — the drawing is what the sentence was for. */}
      <Section icon={<RoomIcon className="h-4 w-4 text-accent-400" />} title="The room">
        <SettingToggle
          label="AI generation"
          sub={
            isHost
              ? "Uses your API keys. Turn off for a players-only session."
              : "Uses the host's API keys, so only the host can change it."
          }
          checked={enableAI}
          onChange={setEnableAI}
          locked={locked}
          accent="violet"
        />
        <SettingToggle
          label="Live keystrokes"
          sub="Show what players are typing as they type. Uses more network."
          checked={liveTyping}
          onChange={setLiveTyping}
          locked={locked}
        />
        <div>
          <Label hint="Continue and Next turn move every screen at once. Choose whether everyone has to press or anyone can.">
            Reading pace
          </Label>
          {/* Options straight from the table the wire is read against, never re-typed. */}
          <Segmented
            fill
            value={continuePolicy}
            options={CONTINUE_POLICY_ROWS.map((row) => ({ id: row.id, label: row.label }))}
            onChange={setContinuePolicy}
            disabled={locked}
          />
        </div>
      </Section>

      <Section icon={<ArmchairIcon className="h-4 w-4 text-accent-400" />} title="Seats">
        {roster.length === 0 ? (
          <Hint text="No one is at the table. Host from the Multiplayer button to fill the seats." />
        ) : (
          <ul className="space-y-1">
            {roster.map((player) => (
              <SeatRow key={player.id} chat={chat} player={player} assign />
            ))}
          </ul>
        )}
      </Section>
    </Surface>
  );
}
