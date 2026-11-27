import {MAX_AREAS, MAX_MARKERS, MAX_MEASURES, MAX_STROKES, getHoloData, sanitizeArea, sanitizeMarker, sanitizeMeasure,
  sanitizeStroke} from "./data.mjs";
import {storageOf, writeHolo} from "./links.mjs";
import {requestAnnotationEdit} from "./socket.mjs";

/** The editable annotation lists, with their size limit and the check every item goes through. */
const LISTS = {
  markers: {max: MAX_MARKERS, sanitize: sanitizeMarker},
  strokes: {max: MAX_STROKES, sanitize: sanitizeStroke},
  measures: {max: MAX_MEASURES, sanitize: sanitizeMeasure},
  areas: {max: MAX_AREAS, sanitize: sanitizeArea}
};

/**
 * @type {Map<string, Promise>} Pending edits per storing document (the tile, or its link's journal when annotations
 * are shared), applied one after another.
 */
const queues = new Map();

/**
 * @typedef {{type: "add", item: object}|{type: "update", id: string, changes: object}
 *          |{type: "delete", id: string}|{type: "clear"}} AnnotationEdit
 */

/**
 * Add, change or remove waypoints ("markers"), strokes or measurements ("measures"). GMs apply the edit themselves;
 * drivers ask the active GM. Edits are operations rather than whole lists, so two people editing at once don't
 * overwrite each other.
 * @param {TileDocument} doc
 * @param {"markers"|"strokes"|"measures"} list
 * @param {AnnotationEdit} edit
 */
export function editAnnotations(doc, list, edit) {
  if ( game.user.isGM ) return applyAnnotationEdit(doc, list, edit);
  return requestAnnotationEdit(doc, list, edit);
}

/**
 * Apply an edit on this (GM) client, after any edits to the same document still in flight.
 * @param {TileDocument} doc
 * @param {string} list
 * @param {AnnotationEdit} edit
 */
export function applyAnnotationEdit(doc, list, edit) {
  if ( !Object.hasOwn(LISTS, list) ) return;
  const key = storageOf(doc, "annotations").uuid;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(() => applyNow(doc, list, edit)).catch(err => console.error("Vira Holo |", err));
  queues.set(key, next);
  return next;
}

async function applyNow(doc, list, edit) {
  if ( !doc.parent?.tiles.has(doc.id) ) return; // Deleted meanwhile
  const {max, sanitize} = LISTS[list];
  const items = foundry.utils.deepClone(getHoloData(doc).annotations[list]);
  const index = items.findIndex(m => m.id === edit.id);
  switch ( edit.type ) {
    case "add": {
      const item = sanitize(edit.item);
      if ( !item || (items.length >= max) || items.some(m => m.id === item.id) ) return;
      items.push(item);
      break;
    }
    case "update": {
      if ( index < 0 ) return;
      const item = sanitize({...items[index], ...edit.changes, id: items[index].id});
      if ( !item ) return;
      items[index] = item;
      break;
    }
    case "delete":
      if ( index < 0 ) return;
      items.splice(index, 1);
      break;
    case "clear":
      items.length = 0;
      break;
    default:
      return;
  }
  await writeHolo(doc, {annotations: {[list]: items}});
}
