"use client";

import React from "react";
import { ShieldIcon } from "@phosphor-icons/react";
import { useTableState } from "./useTableState";
import {
  NOTE_SEAL_ROWS,
  NOTE_VISIBILITY_ROWS,
  PERMISSION_ACTIONS,
  permissionCoveredBy,
  permissionLayout,
  type GuestPermissionId,
  type GuestPermissions,
} from "../client/permissions";
import { useRoomStore } from "../client/roomStore";
import { ui, app } from "@dahlia/plugin-api";
import type { Chat } from "@dahlia/plugin-api";

const { TYPE } = app.parts;
const { Label, Segmented, Hint, Section, SettingToggle, Switch } = ui;

/**
 * **Settings → Autonomy → Guests: what someone at your table may do, and what they may read.**
 *
 * These stood in Chat style's table region beside the room and the seats. They are permissions —
 * what a guest may edit, delete or read — and Autonomy is the screen that answers "what may happen
 * here without you". The room (AI generation, live keystrokes, reading pace) and the seats stay on
 * Chat style: they are how the session runs, not what anyone is allowed.
 *
 * Live session state like the rest of the table: written through `roomStore`'s host-only actions,
 * locked for a guest and while nobody is hosting (`useTableState`), and drawn only for a chat that
 * has a table at all.
 */
export function GuestRightsSection({ chat }: { chat: Chat | null }) {
  const { drawn, locked, status } = useTableState(chat);
  const noteVisibility = useRoomStore((s) => s.noteVisibility);
  const noteSeal = useRoomStore((s) => s.noteSeal);
  const permissions = useRoomStore((s) => s.permissions);
  const setNoteVisibility = useRoomStore((s) => s.setNoteVisibility);
  const setNoteSeal = useRoomStore((s) => s.setNoteSeal);
  const setGuestPermission = useRoomStore((s) => s.setGuestPermission);

  if (!drawn) return null;

  return (
    <Section icon={<ShieldIcon className="h-4 w-4 text-accent-400" />} title="Guests" action={<span className={TYPE.hint}>{status}</span>}>
      <PermissionMatrix permissions={permissions} locked={locked} onSet={setGuestPermission} />
      <div>
        <Label hint="Who at the table can read a Director's note. “Who it's for” shows a note to the player of the character it names. You can always read your own notes.">
          Director&apos;s notes
        </Label>
        {/* Options straight from the table, never re-typed: a policy the wire carries and
            the screen cannot offer is a setting nobody can reach. */}
        <Segmented
          fill
          value={noteVisibility}
          options={NOTE_VISIBILITY_ROWS.map((row) => ({ id: row.id, label: row.label }))}
          onChange={setNoteVisibility}
          disabled={locked}
        />
      </div>
      {/* Only where its answer can differ: with everyone reading everything there is no
          note anybody is being kept from, so the question has nothing to decide. */}
      {noteVisibility !== "everyone" && (
        <div>
          <Label hint="What other players see where a note they can't read sits. A sealed card shows a note is there without its text.">
            What they see instead
          </Label>
          <Segmented
            fill
            value={noteSeal}
            options={NOTE_SEAL_ROWS.map((row) => ({ id: row.id, label: row.label }))}
            onChange={setNoteSeal}
            disabled={locked}
          />
        </div>
      )}
      <Hint text="The host's tab enforces these, whatever a guest's screen shows." />
    </Section>
  );
}

/**
 * **The four message rights as a grid, because that is what they are.**
 *
 * Each is a *verb* applied to a *scope*, and drawing them as four full-width toggle rows said
 * "including the narrator's and other players'" twice in prose nobody reads. The cell is the
 * sentence: Edit × Anyone's lines needs no sub-line at all.
 *
 * Derived from `permissionLayout()`, never drawn by hand — a hand-built 2×2 would have to be
 * edited to stay true and would not be, and a right with no verb falls out as its own row
 * rather than as a blank cell.
 *
 * "Anyone's lines" implies "their own", which `guestMayActOnMessage` already ORs. The covered
 * cell draws on-and-disabled, and it asks `permissionCoveredBy` rather than restating the
 * implication — a picture that states the rule from a second copy of it is clever rather than
 * honest.
 */
function PermissionMatrix({
  permissions,
  locked,
  onSet,
}: {
  permissions: GuestPermissions;
  locked: boolean;
  onSet: (id: GuestPermissionId, granted: boolean) => void;
}) {
  const { grid, rest } = permissionLayout();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-5 gap-y-2.5">
        <span />
        {PERMISSION_ACTIONS.map((action) => (
          <span key={action.id} className={`justify-self-center ${TYPE.sectionHeading}`}>
            {action.label}
          </span>
        ))}
        {grid.map(({ scope, cells }) => (
          <React.Fragment key={scope.id}>
            <span className={`truncate ${TYPE.label}`}>{scope.label}</span>
            {cells.map((id, i) => (
              <span key={PERMISSION_ACTIONS[i].id} className="justify-self-center">
                {id && (
                  <Switch
                    checked={permissions[id] || permissionCoveredBy(id, permissions)}
                    onChange={(on) => onSet(id, on)}
                    label={`${PERMISSION_ACTIONS[i].label} ${scope.label.toLowerCase()}`}
                    accent={scope.accent}
                    disabled={locked || permissionCoveredBy(id, permissions)}
                  />
                )}
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>

      {rest.map((row) => (
        <SettingToggle
          key={row.id}
          label={row.label}
          sub={row.sub}
          checked={permissions[row.id]}
          onChange={(on) => onSet(row.id, on)}
          locked={locked}
        />
      ))}
    </div>
  );
}
