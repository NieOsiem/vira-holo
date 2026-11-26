// Vira Holo — holographic projections of maps, images, and text.
import {registerTileHooks} from "./scripts/tile-holo.mjs";
import {registerInteraction} from "./scripts/interaction.mjs";
import {registerSocket} from "./scripts/socket.mjs";
import {registerConfigHooks} from "./scripts/holo-config.mjs";

Hooks.once("init", () => {
  registerTileHooks();
  registerInteraction();
  registerConfigHooks();
});

Hooks.once("ready", registerSocket);
