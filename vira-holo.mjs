// Vira Holo — holographic projections of maps, images, and text.
import {registerTileHooks} from "./scripts/tile-holo.mjs";
import {registerInteraction} from "./scripts/interaction.mjs";
import {registerSocket} from "./scripts/socket.mjs";
import {registerConfigHooks} from "./scripts/holo-config.mjs";
import {api} from "./scripts/api.mjs";
import {MODULE_ID} from "./scripts/data.mjs";

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = api;
  registerTileHooks();
  registerInteraction();
  registerConfigHooks();
});

Hooks.once("ready", registerSocket);
