import { wireMultiplayer } from "./client";
import { useRoomStore, type RoomStore } from "./roomStore";
import { hostingAllowed } from "./hosting";
import { ChatLayer, HomeLayer, openLobby } from "../components/Layers";
import { HostingElsewhere } from "../components/HostingElsewhere";
import { TypingPresence } from "../components/TypingPresence";
import { OocChat } from "../components/OocChat";
import { TableRegion } from "../components/TableRegion";
import { GuestRightsSection } from "../components/GuestRightsSection";
import { JoinPage } from "../components/JoinPage";
import { JOIN_PAGE } from "../mount";
import { Plugin } from "@dahlia/plugin-api";

/** This tab sits at somebody else's table. */
function guestSeated(room: RoomStore): boolean {
  return room.phase === "lobby" && !room.isHost;
}

/**
 * **The Multiplayer plugin's client half.** Loaded by the client runtime (`lib/plugins/runtime.ts`)
 * when the plugin is switched on, or woken on a guest's tab; `onload` wires the engine into the tab
 * and puts its pieces in the app's slots, and `unload` takes every piece of it back out.
 */
export class MultiplayerPlugin extends Plugin {
  private unwire: (() => void) | null = null;
  private offDoors: (() => void)[] = [];
  private offTab: (() => void) | null = null;
  private drawn = "";

  onload(): void {
    this.unwire ??= wireMultiplayer();
    this.addSlot("app.overlay", "hosting-elsewhere", HostingElsewhere);
    this.addSlot("chat.layer", "lobby", ChatLayer);
    this.addSlot("home.layer", "lobby", HomeLayer);
    this.addSlot("composer.foot", "typing", TypingPresence);
    this.addSlot("chatStyle.section", "table", TableRegion);
    this.addSlot("autonomy.section", "guest-rights", GuestRightsSection);
    this.addPage(JOIN_PAGE, JoinPage);
    this.drawDoors();
    this.registerEvent(useRoomStore.subscribe(() => this.drawDoors()));
    // A guest's tab reloads on the chat screen, not the join page that woke the plugin: it asks to be
    // woken again while it sits at a table, and lets go when it stands up.
    this.keepAwake(guestSeated(useRoomStore.getState()));
    this.registerEvent(useRoomStore.subscribe((s) => this.keepAwake(guestSeated(s))));
    // A guest who stands up from somebody else's table needs nothing of the plugin any more: on a tab
    // that does not host, it goes (`pluginRuntime.rest`); an invite link is the way back in.
    this.registerEvent(
      useRoomStore.subscribe((s, prev) => {
        if (prev.phase === "lobby" && !prev.isHost && s.phase === "idle" && !hostingAllowed()) {
          queueMicrotask(() => this.rest());
        }
      })
    );
    this.registerEvent(this.app.plugins.subscribe(() => this.drawDoors()));
    this.registerCleanup(() => {
      for (const off of this.offDoors.splice(0)) off();
      this.offTab?.();
      this.offTab = null;
      this.drawn = "";
    });
  }

  onunload(): void {
    this.unwire?.();
    this.unwire = null;
  }

  /**
   * **The doors, as the room stands.** The lobby is offered while this machine may host (the plugin
   * switched on, read off its record) — and always inside a room: a guest who came in by a link has
   * no plugin switched on, and the lobby is where they leave (D3). Redrawn only when what it draws
   * changes, so a typing ping does not re-file every door.
   */
  private drawDoors(): void {
    const room: RoomStore = useRoomStore.getState();
    const inRoom = room.phase === "lobby";
    const hosting = hostingAllowed();
    const shape = JSON.stringify([inRoom, hosting, inRoom ? room.code : null, inRoom ? room.oocUnread : null]);
    if (shape === this.drawn) return;
    this.drawn = shape;
    for (const off of this.offDoors.splice(0)) off();
    if (inRoom || hosting) {
      this.offDoors.push(
        this.addHeaderAction({ id: "room", label: inRoom ? "The room" : "Multiplayer", icon: "room", lit: inRoom, onClick: openLobby }),
        this.addHomeDoor({
          id: "room",
          label: inRoom && room.code ? `In room ${room.code}` : "Multiplayer",
          short: "Play",
          icon: "room",
          lit: inRoom,
          onClick: openLobby,
        })
      );
    }
    // Table talk exists only while a room is up, with what arrived while nobody was on its tab.
    this.offTab?.();
    this.offTab = inRoom ? this.addPaneTab({ id: "ooc", label: "OOC", count: room.oocUnread, Panel: OocChat }) : null;
  }
}
