import { app } from "@dahlia/plugin-api";
import { MULTIPLAYER_PLUGIN_ID } from "../mount";

/**
 * **This machine may host** — the plugin installed and switched on, read off its record, the one
 * place that says so. A tab can have the plugin loaded without it (a guest's, woken by the join
 * page or a remembered seat), and then it offers no lobby to host from (D3).
 */
export function hostingAllowed(): boolean {
  return app.plugins.isOn(MULTIPLAYER_PLUGIN_ID);
}

/** The same, as a hook: redrawn when the records change. */
export function useHostingAllowed(): boolean {
  return app.plugins.useIsOn(MULTIPLAYER_PLUGIN_ID);
}
