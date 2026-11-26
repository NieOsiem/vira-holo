import {MAX_MARKERS, getHoloData, sanitizeMarker} from "./data.mjs";
import {storageOf, writeHolo} from "./links.mjs";
import {requestMarkerEdit} from "./socket.mjs";

/**
 * @type {Map<string, Promise>} Pending edits per storing document (the tile, or its link's journal when waypoints
 * are shared), applied one after another.
 */
const queues = new Map();

/**
 * @typedef {{type: "add", marker: object}|{type: "update", id: string, changes: object}
 *          |{type: "delete", id: string}|{type: "clear"}} MarkerEdit
 */

/**
 * Add, change or remove waypoints. GMs apply the edit themselves; drivers ask the active GM.
 * Edits are operations rather than whole lists, so two people editing at once don't overwrite each other.
 * @param {TileDocument} doc
 * @param {MarkerEdit} edit
 */
export function editMarkers(doc, edit) {
  if ( game.user.isGM ) return applyMarkerEdit(doc, edit);
  return requestMarkerEdit(doc, edit);
}

/**
 * Apply an edit on this (GM) client, after any edits to the same tile still in flight.
 * @param {TileDocument} doc
 * @param {MarkerEdit} edit
 */
export function applyMarkerEdit(doc, edit) {
  const key = storageOf(doc, "annotations").uuid;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(() => applyNow(doc, edit)).catch(err => console.error("Vira Holo |", err));
  queues.set(key, next);
  return next;
}

async function applyNow(doc, edit) {
  if ( !doc.parent?.tiles.has(doc.id) ) return; // Deleted meanwhile
  const markers = foundry.utils.deepClone(getHoloData(doc).annotations.markers);
  const index = markers.findIndex(m => m.id === edit.id);
  switch ( edit.type ) {
    case "add": {
      const marker = sanitizeMarker(edit.marker);
      if ( !marker || (markers.length >= MAX_MARKERS) || markers.some(m => m.id === marker.id) ) return;
      markers.push(marker);
      break;
    }
    case "update": {
      if ( index < 0 ) return;
      const marker = sanitizeMarker({...markers[index], ...edit.changes, id: markers[index].id});
      if ( !marker ) return;
      markers[index] = marker;
      break;
    }
    case "delete":
      if ( index < 0 ) return;
      markers.splice(index, 1);
      break;
    case "clear":
      markers.length = 0;
      break;
    default:
      return;
  }
  await writeHolo(doc, {annotations: {markers}});
}
