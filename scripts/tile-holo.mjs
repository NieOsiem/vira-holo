import {MODULE_ID, getLink} from "./data.mjs";
import {storageOf} from "./links.mjs";
import HoloRenderer from "./holo-renderer.mjs";

/** @type {Map<Tile, HoloRenderer>} */
const holograms = new Map();

/**
 * Hit-testing normally reads the tile texture's alpha back from the GPU once and caches it. For a live render
 * texture that snapshot would be stale (and the readback costly), so the whole tile rectangle counts as solid.
 * Foundry drops it whenever the texture updates (e.g. the render texture is reallocated), so it is set every frame.
 */
const SOLID_ALPHA = Object.freeze({data: new Uint8Array([255]), width: 1, height: 1, minX: 0, minY: 0, maxX: 1, maxY: 1});

/** @returns {Map<Tile, HoloRenderer>} Holograms on the current canvas */
export function getHolograms() {
  return holograms;
}

/**
 * Show an unsaved camera on a tile's hologram and on every hologram that shares its view through the same link.
 * @param {TileDocument} doc
 * @param {object} camera
 * @param {object} [options]
 * @param {boolean} [options.smooth=false]  Ease towards it (another user's camera)
 */
export function showLiveCamera(doc, camera, {smooth=false}={}) {
  const link = getLink(doc);
  const viewLink = link?.share.view ? link.journal.uuid : null;
  for ( const [tile, holo] of holograms ) {
    const sibling = viewLink && (holo.data.link?.uuid === viewLink) && holo.data.link.share.view;
    if ( (tile.document === doc) || sibling ) holo.setLiveCamera(camera, {smooth});
  }
}

/**
 * Show another user's edit in progress on every hologram that stores its annotations where this tile does.
 * @param {TileDocument} doc
 * @param {string} userId
 * @param {object} preview   Sanitized
 */
export function showPreview(doc, userId, preview) {
  const storage = storageOf(doc, "annotations").uuid;
  for ( const [tile, holo] of holograms ) {
    if ( storageOf(tile.document, "annotations").uuid === storage ) holo.applyPreview(userId, preview);
  }
}

/**
 * Re-read holograms when a link journal was created, changed or deleted. Links are also maps, which affect more
 * than the tiles linked to them (the map shown, portals on its parent, the parent's name), so re-read them all.
 */
function onLinkChanged(journal) {
  if ( !journal.flags[MODULE_ID] ) return;
  for ( const tile of holograms.keys() ) syncTile(tile);
}

export function registerTileHooks() {
  Hooks.on("createJournalEntry", onLinkChanged);
  Hooks.on("updateJournalEntry", onLinkChanged);
  Hooks.on("deleteJournalEntry", onLinkChanged);
  // Signs showing the in-game time, or a journal's pages, re-read their content when those change.
  Hooks.on("updateWorldTime", () => {
    for ( const holo of holograms.values() ) if ( holo.showsTime ) holo.refreshText();
  });
  const onJournal = () => {
    for ( const holo of holograms.values() ) {
      if ( (holo.data.mode === "text") && (holo.data.text.source === "journal") ) holo.refreshText();
    }
  };
  for ( const hook of ["updateJournalEntry", "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"] ) {
    Hooks.on(hook, onJournal);
  }
  Hooks.on("drawTile", syncTile);
  Hooks.on("refreshTile", onRefreshTile);
  Hooks.on("destroyTile", tile => detach(tile, {restore: false}));
  Hooks.on("updateTile", onUpdateTile);
  Hooks.once("canvasReady", () => canvas.app.ticker.add(renderHolograms));
}

/** @param {Tile} tile */
function syncTile(tile) {
  if ( tile.isPreview ) return;
  const enabled = !!tile.document.getFlag(MODULE_ID, "enabled");
  let holo = holograms.get(tile);
  if ( !enabled ) {
    if ( holo ) detach(tile);
    return;
  }
  if ( !tile.mesh ) adoptMesh(tile);
  if ( holo ) holo.configure();
  else {
    holo = new HoloRenderer(tile);
    holograms.set(tile, holo);
  }
  claimMesh(tile, holo);
}

/**
 * Foundry gives tiles without an image a placeholder instead of a mesh. A text hologram needs no image, so give
 * the tile a mesh of its own; every use of the placeholder in core is guarded by the mesh being absent.
 */
function adoptMesh(tile) {
  tile.mesh = canvas.primary.addTile(tile);
  tile.bg?.destroy();
  tile.bg = null;
  tile.renderFlags.set({refresh: true});
}

/**
 * Show the hologram's render texture in place of the tile's image, so the tile keeps its sorting, occlusion,
 * fog masking and level handling (core and the Levels module) unchanged.
 */
function claimMesh(tile, holo) {
  const mesh = tile.mesh;
  if ( mesh.texture !== holo.texture ) mesh.texture = holo.texture;
  mesh._textureAlphaData = SOLID_ALPHA;
  tile.renderFlags.set({refreshSize: true});
}

/**
 * @param {Tile} tile
 * @param {object} [options]
 * @param {boolean} [options.restore=true]  Give the tile its own image (or placeholder) back. Not wanted while
 *                                          the tile is being destroyed.
 */
function detach(tile, {restore=true}={}) {
  const holo = holograms.get(tile);
  if ( !holo ) return;
  holograms.delete(tile);
  const mesh = tile.mesh;
  if ( restore && mesh && !mesh.destroyed && (mesh.texture === holo.texture) ) {
    // An adopted mesh (no image) goes back to Foundry's placeholder via a redraw.
    if ( tile.texture ) {
      mesh.texture = tile.texture;
      tile.renderFlags.set({refreshSize: true});
    }
    else tile.renderFlags.set({redraw: true});
  }
  holo.destroy();
}

function onRefreshTile(tile, flags) {
  const holo = holograms.get(tile);
  if ( !holo || !flags.refreshSize ) return;
  // A resized render texture fires a texture update, which drops the alpha data and needs a fresh mesh size.
  if ( holo.resize() ) claimMesh(tile, holo);
  else tile.mesh._textureAlphaData = SOLID_ALPHA;
}

function onUpdateTile(doc, changes) {
  const flagsChanged = (MODULE_ID in (changes.flags ?? {})) || (`-=${MODULE_ID}` in (changes.flags ?? {}));
  if ( flagsChanged && doc.object ) syncTile(doc.object);
}

function isShown(tile) {
  const mesh = tile.mesh;
  return tile.visible && !!mesh?.visible && mesh.renderable && (mesh.worldAlpha > 0);
}

function renderHolograms() {
  if ( !holograms.size ) return;
  const {renderer, ticker} = canvas.app;
  for ( const [tile, holo] of holograms ) {
    // Only the part of the hologram on screen is rendered, at the screen's pixel density.
    if ( !isShown(tile) || !holo.fitViewport(renderer) ) continue;
    tile.mesh._textureAlphaData = SOLID_ALPHA;
    holo.update(ticker.deltaMS);
    holo.render(renderer);
  }
}
