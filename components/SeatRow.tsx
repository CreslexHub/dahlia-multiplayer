"use client";

import React from "react";
import { CrownIcon, XIcon } from "@phosphor-icons/react";
import { useRoomStore } from "../client/roomStore";
import { ui, app } from "@dahlia/plugin-api";
import type { Chat } from "@dahlia/plugin-api";

const { isPlayerCharacterId, tableCharacterFor } = app.cast;
const { ConfirmDeleteButton, MessageAvatar, TYPE, chipAvatarBox, useResolvedAppearance } = app.parts;
const { Select } = ui;

/**
 * One person at the table.
 *
 * There were three renderings of this and they disagreed about everything: the lobby drew a
 * name and a kick, the Multiplayer tab drew a name, a claim select, a loop select and a kick,
 * and neither showed the face the account actually wears — which is the one thing a host
 * looking at a roster wants to see, because a claim is *about* that face.
 *
 * `assign` is the difference between the two surfaces, and it is a claim about which screen
 * you are on rather than a switch for turning controls off. The lobby is the small door: it
 * says who is here and offers "Playing as" for yourself, which is the only control that can
 * reach your own shelf of cards. Deciding who plays whom is the deep surface's question, and
 * the lobby's Table settings button is how you get there.
 */
export function SeatRow({
  chat,
  player,
  assign,
}: {
  chat: Chat | null;
  player: { id: string; name: string; isHost: boolean };
  /** Whether this surface decides who plays whom, or only reports it. */
  assign: boolean;
}) {
  const selfId = useRoomStore((s) => s.selfId);
  const isHost = useRoomStore((s) => s.isHost);
  const claims = useRoomStore((s) => s.claims);
  const assignClaim = useRoomStore((s) => s.assignClaim);
  const kickPlayer = useRoomStore((s) => s.kickPlayer);

  const box = chipAvatarBox(useResolvedAppearance(chat?.chatSettings.appearance));
  const worn = chat ? tableCharacterFor(chat, player.id, claims, player.isHost) : null;

  /** The story's own player-controlled cards — never the ones minted for other accounts. */
  const claimable = (chat?.characters ?? []).filter(
    (c) => c.roleSetting === "user" && !isPlayerCharacterId(c.id)
  );

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-2.5 rounded-lg bg-surface-100/40 px-3 py-1.5 text-xs text-ink-600">
      {player.isHost && <CrownIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}
      <span className="block h-6 w-6 shrink-0">
        <MessageAvatar speakerCharacter={worn} speakerName={player.name} box={box} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {player.name}
        {player.id === selfId && <span className="text-ink-200"> (you)</span>}
      </span>

      {assign ? (
        <Select
          aria-label={`Character ${player.name} plays`}
          value={claims[player.id] ?? ""}
          disabled={!isHost}
          onChange={(e) => assignClaim(player.id, e.target.value || null)}
          className="w-40"
        >
          <option value="">Their own card</option>
          {claimable.map((c) => {
            const heldByOther = Object.entries(claims).some(
              ([owner, held]) => held === c.id && owner !== player.id
            );
            return (
              <option key={c.id} value={c.id} disabled={heldByOther}>
                {c.name}
                {heldByOther ? " — taken" : ""}
              </option>
            );
          })}
        </Select>
      ) : (
        worn && <span className={`shrink-0 ${TYPE.hint}`}>as {worn.name}</span>
      )}

      {/* Where this player sits in a round is their card's place in the turn loop — Chat style →
          Voices and turns — not a second control here. One list, one drag. */}
      {/* Two presses: a removed player is out of the story and their code stops working for
          them, and one stray tap on a row of names used to do it. */}
      {isHost && player.id !== selfId && (
        <ConfirmDeleteButton
          label={`Remove ${player.name}`}
          confirmLabel={`Remove ${player.name} from the room`}
          icon={<XIcon className="h-3.5 w-3.5" />}
          onConfirm={() => void kickPlayer(player.id).then((failed) => failed && ui.showNotice(failed))}
        />
      )}
    </li>
  );
}
