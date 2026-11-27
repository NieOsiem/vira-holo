import {MODULE_ID, getHoloData} from "./data.mjs";
import {writeHolo} from "./links.mjs";
import {arrivalCamera} from "./maps.mjs";
import {broadcastPreview, saveDriverChanges} from "./socket.mjs";
import {getHolograms, showPreview} from "./tile-holo.mjs";
import {parsePages} from "./text-panel.mjs";

/**
 * A hologram's tile from a Tile, TileDocument, UUID, or the ID of a tile on the scene being viewed.
 * @param {Tile|TileDocument|string} target
 * @returns {TileDocument}
 */
function resolve(target) {
  let doc = target;
  if ( typeof target === "string" ) doc = target.includes(".") ? fromUuidSync(target, {strict: false}) : canvas.scene?.tiles.get(target);
  else if ( target?.document ) doc = target.document;
  if ( doc?.documentName !== "Tile" ) throw new Error(`Vira Holo | ${target} is not a tile`);
  return doc;
}

/** The renderer of a tile on the scene being viewed, if it is a hologram there. */
function rendererOf(doc) {
  return doc.object ? getHolograms().get(doc.object) ?? null : null;
}

/**
 * Scripting interface, at `game.modules.get("vira-holo").api`. Tiles may be given as a Tile, TileDocument, UUID or
 * the ID of a tile on the scene being viewed. Changes go through the active GM like a driver's, so a player's script
 * may only change holograms the player can drive.
 */
export const api = {
  /**
   * The hologram's effective state (defaults, link and map included).
   * @param {Tile|TileDocument|string} tile
   * @returns {object}
   */
  data(tile) {
    return getHoloData(resolve(tile));
  },

  /** The hologram tiles on a scene (by default the one being viewed). */
  holograms(scene=canvas.scene) {
    return scene?.tiles.filter(t => t.getFlag(MODULE_ID, "enabled")) ?? [];
  },

  /**
   * Switch a hologram on or off.
   * @param {Tile|TileDocument|string} tile
   * @param {boolean} [on]    On, off, or (omitted) the other way round
   */
  async power(tile, on) {
    const doc = resolve(tile);
    const powered = (typeof on === "boolean") ? on : !getHoloData(doc).powered;
    return saveDriverChanges(doc, {powered});
  },

  /**
   * Turn a sign paged by hand to a page.
   * @param {Tile|TileDocument|string} tile
   * @param {number|"next"|"previous"} page    A page number from 1, or a step
   */
  async page(tile, page) {
    const doc = resolve(tile);
    const data = getHoloData(doc);
    if ( (data.mode !== "text") || (data.text.paging !== "manual") ) {
      throw new Error("Vira Holo | Only signs paged by hand (Paging: by hand) can be turned to a page");
    }
    const holo = rendererOf(doc);
    // The page shown: from the sign if it's on screen, else counted from its text (journal content wraps on the sign).
    const count = holo?.pageCount || ((data.text.source === "text") ? parsePages(data.text.content ?? "").length : 0);
    const current = holo ? holo.shownPage : (Math.trunc(data.page) || 0);
    let target;
    if ( page === "next" ) target = current + 1;
    else if ( page === "previous" ) target = current - 1;
    else if ( Number.isInteger(page) ) target = page - 1;
    else throw new Error(`Vira Holo | Unknown page ${page}`);
    if ( count ) target = ((target % count) + count) % count;
    return saveDriverChanges(doc, {page: target});
  },

  /**
   * Travel to a map: one placed on the map shown, its parent, or home (null).
   * @param {Tile|TileDocument|string} tile
   * @param {string|null} map   A map's journal UUID, or null for home
   */
  async travel(tile, map) {
    const doc = resolve(tile);
    return saveDriverChanges(doc, {camera: await arrivalCamera(getHoloData(doc), map), map});
  },

  /**
   * Ping a spot on the hologram for everyone (like Ctrl+click).
   * @param {Tile|TileDocument|string} tile
   * @param {number} u    Across the image, 0 (left) to 1 (right)
   * @param {number} v    Down the image, 0 (top) to 1 (bottom)
   * @param {object} [options]
   * @param {string} [options.color]  A #rrggbb colour (default: this user's)
   */
  ping(tile, u, v, {color=game.user.color.css}={}) {
    const doc = resolve(tile);
    const preview = {kind: "ping", u: Math.clamp(u, 0, 1), v: Math.clamp(v, 0, 1), color};
    showPreview(doc, game.user.id, preview);
    broadcastPreview(doc, preview);
  },

  /**
   * Replace a sign's text (GMs only). Linked signs all change.
   * @param {Tile|TileDocument|string} tile
   * @param {string} content
   */
  async setText(tile, content) {
    if ( !game.user.isGM ) throw new Error("Vira Holo | Only GMs can change a sign's text");
    return writeHolo(resolve(tile), {text: {content: String(content)}});
  }
};
