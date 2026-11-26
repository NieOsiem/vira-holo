import {editAnnotations} from "./annotations.mjs";
import {storageOf} from "./links.mjs";

/** Most steps kept per hologram (or per link, when annotations are shared). */
const MAX_STEPS = 40;

/**
 * This user's undo and redo stacks, keyed by the document that stores the annotations (the tile, or its link's
 * journal), so linked holograms share one history. Each step is a list of {list, edit, inverse} changes.
 * @type {Map<string, {undo: object[][], redo: object[][]}>}
 */
const histories = new Map();
/** @type {Set<Function>} */
const listeners = new Set();
/** A step being collected over a gesture (an eraser scrub), or null. */
let group = null;

/**
 * Change an annotation and remember how to take the change back. Only this user's own changes are recorded.
 * @param {TileDocument} doc
 * @param {"markers"|"strokes"|"measures"} list
 * @param {import("./annotations.mjs").AnnotationEdit} edit
 * @param {object|object[]} [before]  The item as it was before an update or delete (all items, for a clear)
 */
export function edit(doc, list, edit, before) {
  editAnnotations(doc, list, edit);
  const inverse = inverseOf(edit, before);
  if ( !inverse.length ) return;
  const change = {list, edit, inverse};
  if ( group ) {
    group.changes.push(change);
    return;
  }
  push(doc, [change]);
}

/** Collect every change until endGroup into a single undo step. */
export function beginGroup(doc) {
  endGroup();
  group = {doc, changes: []};
}

export function endGroup() {
  if ( group?.changes.length ) push(group.doc, group.changes);
  group = null;
}

/** @param {TileDocument} doc */
export function canUndo(doc) {
  return !!historyOf(doc)?.undo.length;
}

/** @param {TileDocument} doc */
export function canRedo(doc) {
  return !!historyOf(doc)?.redo.length;
}

/** Take back this user's last change to the hologram's annotations. */
export function undo(doc) {
  const history = historyOf(doc);
  const step = history?.undo.pop();
  if ( !step ) return;
  for ( const {list, inverse} of [...step].reverse() ) {
    for ( const change of inverse ) editAnnotations(doc, list, change);
  }
  history.redo.push(step);
  notify();
}

/** Do the last undone change again. */
export function redo(doc) {
  const history = historyOf(doc);
  const step = history?.redo.pop();
  if ( !step ) return;
  for ( const {list, edit} of step ) editAnnotations(doc, list, edit);
  history.undo.push(step);
  notify();
}

/** Call a function whenever what can be undone or redone changes. */
export function onHistoryChange(fn) {
  listeners.add(fn);
}

function push(doc, step) {
  const key = storageOf(doc, "annotations").uuid;
  if ( !histories.has(key) ) histories.set(key, {undo: [], redo: []});
  const history = histories.get(key);
  history.undo.push(step);
  if ( history.undo.length > MAX_STEPS ) history.undo.shift();
  history.redo.length = 0;
  notify();
}

function historyOf(doc) {
  return histories.get(storageOf(doc, "annotations").uuid);
}

function notify() {
  for ( const fn of listeners ) fn();
}

/**
 * The edits that undo an edit. They go through the GM like any edit, so one that no longer applies (the item was
 * deleted or re-added by someone else meanwhile) does nothing.
 * @returns {object[]}
 */
function inverseOf(edit, before) {
  const clone = foundry.utils.deepClone;
  switch ( edit.type ) {
    case "add": return [{type: "delete", id: edit.item.id}];
    case "delete": return before ? [{type: "add", item: clone(before)}] : [];
    case "update": {
      if ( !before ) return [];
      const changes = Object.fromEntries(Object.keys(edit.changes).map(key => [key, clone(before[key])]));
      return [{type: "update", id: edit.id, changes}];
    }
    case "clear": return (before ?? []).map(item => ({type: "add", item: clone(item)}));
    default: return [];
  }
}
