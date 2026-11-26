// Vira Holo — holographic projections of maps, images, and text.
import {registerTileHooks} from "./scripts/tile-holo.mjs";

Hooks.once("init", () => {
  registerTileHooks();
});
