import {DEFAULTS, LABEL_SHOWS, MARKER_SIZES, MAX_LABEL_LENGTH, MODULE_ID, deletionUpdate, getHoloData, getLink, getMaps,
  getStateJournal} from "./data.mjs";
import {createLink, createStateJournal} from "./links.mjs";

/** Parent chains are walked at most this far, so a broken (circular) chain can't hang anything. */
const MAX_DEPTH = 64;

/** Every map (link journal), as {uuid: name}, without one map and the maps below it (they can't be its parent). */
export function parentChoices(uuid) {
  const maps = game.journal.filter(j => j.getFlag(MODULE_ID, "state") && !isWithin(j, uuid));
  return Object.fromEntries(maps.map(j => [j.uuid, j.name]));
}

/** Is a map the given one, or below it? */
function isWithin(journal, uuid) {
  for ( let depth = 0; journal && (depth < MAX_DEPTH); depth++ ) {
    if ( journal.uuid === uuid ) return true;
    journal = getStateJournal(journal.getFlag(MODULE_ID, "state").parent?.uuid);
  }
  return false;
}

/**
 * The map the tile shows, made into one first if the tile is at home on its own settings: its content then becomes
 * a link, as with "New link from this hologram".
 * @param {TileDocument} doc
 * @param {string} name   Name for a new map
 * @returns {Promise<JournalEntry>}
 */
async function ensureMap(doc, name) {
  return getStateJournal(getHoloData(doc).map.uuid) ?? createLink(doc, name);
}

/** State for a new, empty map. */
function emptyMap(parent) {
  return {annotations: {markers: [], strokes: [], measures: []}, ...(parent ? {parent} : {})};
}

/**
 * Put a new, empty map above the one shown, with the shown map in its middle. If the shown map had a parent, the
 * new map takes its place there.
 * @param {TileDocument} doc
 * @param {string} name   Name for the shown map, if it has to become one
 */
export async function addMapAbove(doc, name) {
  const map = await ensureMap(doc, name);
  const parent = map.getFlag(MODULE_ID, "state").parent;
  const above = await createStateJournal(game.i18n.localize("VIRAHOLO.Maps.NewName"), emptyMap(parent));
  await map.update({[`flags.${MODULE_ID}.state.parent`]: {uuid: above.uuid, u: 0.5, v: 0.5}});
}

/**
 * Put a new, empty map in the middle of the one shown.
 * @param {TileDocument} doc
 * @param {string} name   Name for the shown map, if it has to become one
 */
export async function addMapInside(doc, name) {
  const map = await ensureMap(doc, name);
  await createStateJournal(game.i18n.localize("VIRAHOLO.Maps.NewName"), emptyMap({uuid: map.uuid, u: 0.5, v: 0.5}));
}

/**
 * Place a map on another (in its middle), or take it off its parent (no uuid). A map can't go below itself.
 * @param {JournalEntry} map
 * @param {string|null} uuid
 */
export async function setParent(map, uuid) {
  const parent = getStateJournal(uuid);
  if ( !parent ) return map.update(deletionUpdate(`flags.${MODULE_ID}.state.parent`));
  if ( isWithin(parent, map.uuid) ) {
    ui.notifications.warn("VIRAHOLO.Maps.Circular", {localize: true});
    return;
  }
  return map.update({[`flags.${MODULE_ID}.state.parent`]: {uuid: parent.uuid, u: 0.5, v: 0.5}});
}

/**
 * Move a map's spot on its parent (GM only: it changes the map journal).
 * @param {string} uuid
 * @param {{u: number, v: number}} position
 */
export async function moveMap(uuid, {u, v}) {
  const map = getStateJournal(uuid);
  if ( !map?.getFlag(MODULE_ID, "state").parent ) return;
  return map.update({[`flags.${MODULE_ID}.state.parent`]: {u: Math.clamp(u, 0, 1), v: Math.clamp(v, 0, 1)}});
}

/**
 * Restyle a map's portal on its parent (size tier, ink, lock) or rename the map (label). GM only: it changes the
 * map journal.
 * @param {string} uuid
 * @param {{label?: string, size?: number, color?: string, locked?: boolean}} changes
 */
export async function updatePortal(uuid, {label, size, color, locked, labelShow}) {
  const map = getStateJournal(uuid);
  if ( !map?.getFlag(MODULE_ID, "state").parent ) return;
  const update = {};
  const name = String(label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
  if ( name ) update.name = name;
  const path = `flags.${MODULE_ID}.state.parent`;
  if ( size in MARKER_SIZES ) update[`${path}.size`] = Number(size);
  if ( /^#[0-9a-f]{6}$/i.test(color) ) update[`${path}.color`] = color;
  if ( typeof locked === "boolean" ) update[`${path}.locked`] = locked;
  if ( LABEL_SHOWS.includes(labelShow) ) update[`${path}.labelShow`] = labelShow;
  if ( !foundry.utils.isEmpty(update) ) return map.update(update);
}

/**
 * Where a hologram on this tile may travel from the map it shows: up to its parent, into a map placed on it, or
 * home. Returns the value to store in camera.map (null for home), or undefined if the move isn't allowed.
 * @param {TileDocument} doc
 * @param {string|null} uuid
 * @returns {string|null|undefined}
 */
export function travelTarget(doc, uuid) {
  const {home} = getMaps(doc, getLink(doc));
  if ( !uuid || (uuid === home?.uuid) ) return null;
  const {map} = getHoloData(doc);
  const allowed = (uuid === map.parent?.uuid) || map.children.some(c => c.uuid === uuid);
  return allowed && getStateJournal(uuid) ? uuid : undefined;
}

/**
 * The camera to arrive with: centred and at the default distance, or, going up, centred on the spot the map just
 * left sits at on its parent (unless the tile recentres, in which case the renderer eases the view from that spot).
 * Yaw, pitch and spin carry over.
 * @param {object} data   Hologram data before travelling
 * @param {string} uuid    The map travelled to
 * @returns {Promise<object>}
 */
export async function arrivalCamera(data, uuid) {
  const camera = {...data.camera, x: 0, z: 0, dist: DEFAULTS.camera.dist};
  delete camera.map;
  if ( data.recenterUp || (data.map.parent?.uuid !== uuid) || !data.map.position ) return camera;
  const {hx, hz} = await footprintOf(getStateJournal(data.map.parent.uuid));
  const {u, v} = data.map.position;
  camera.x = Math.clamp(((u * 2) - 1) * hx, -1, 1);
  camera.z = Math.clamp((1 - (v * 2)) * hz, -1, 1);
  return camera;
}

/**
 * Half extents of a map's image on the floor, as the renderer fits it: its aspect inside a unit circle.
 * @param {JournalEntry} map
 */
async function footprintOf(map) {
  const src = map?.getFlag(MODULE_ID, "state").image;
  const loadTexture = foundry.canvas.loadTexture ?? globalThis.loadTexture;
  const texture = src ? await loadTexture(src).catch(() => null) : null;
  const aspect = (texture?.width && texture?.height) ? (texture.width / texture.height) : 1;
  const diagonal = Math.hypot(aspect, 1);
  return {hx: aspect / diagonal, hz: 1 / diagonal};
}
