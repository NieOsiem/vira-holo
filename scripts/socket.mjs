import {DISPLAY_MODES, INKS, MAX_STROKE_POINTS, MODULE_ID, STROKE_WIDTHS, canDrive, sanitizeMeasure,
  sanitizeStroke} from "./data.mjs";
import {applyAnnotationEdit} from "./annotations.mjs";
import {writeHolo} from "./links.mjs";
import {travelTarget} from "./maps.mjs";
import {showLiveCamera, showPreview} from "./tile-holo.mjs";

const EVENT = `module.${MODULE_ID}`;
const CAMERA_KEYS = ["yaw", "pitch", "dist", "x", "z", "spin"];
const TAU = Math.PI * 2;

export function registerSocket() {
  // The server appends the sender's user ID, so it can be trusted (unlike anything inside the message).
  game.socket.on(EVENT, (message, senderId) => {
    const sender = game.users.get(senderId);
    if ( message?.action === "camera" ) onCamera(message, sender);
    else if ( message?.action === "save" ) onSave(message, sender);
    else if ( message?.action === "annotations" ) onAnnotations(message, sender);
    else if ( message?.action === "preview" ) onPreview(message, sender);
  });
}

/** The active GM, or null with a warning to the user when no GM is connected to save changes. */
function activeGM() {
  const gm = game.users.activeGM;
  if ( !gm ) ui.notifications.warn("VIRAHOLO.NoActiveGM", {localize: true});
  return gm;
}

/**
 * Ask the active GM to apply a waypoint or stroke edit.
 * @param {TileDocument} doc
 * @param {"markers"|"strokes"|"measures"} list
 * @param {import("./annotations.mjs").AnnotationEdit} edit
 */
export function requestAnnotationEdit(doc, list, edit) {
  const gm = activeGM();
  if ( gm ) game.socket.emit(EVENT, {action: "annotations", uuid: doc.uuid, list, edit}, {recipients: [gm.id]});
}

/**
 * Show a camera on everyone else's screen right away, without saving it.
 * @param {TileDocument} doc
 * @param {object} camera
 */
export function broadcastCamera(doc, camera) {
  game.socket.emit(EVENT, {action: "camera", uuid: doc.uuid, camera: pickCamera(camera)});
}

/**
 * Show everyone else an edit in progress (a pin or measurement end being dragged, a stroke or measurement being
 * drawn). Nothing is saved; the edit itself still goes through the GM when it's done.
 * @param {TileDocument} doc
 * @param {object} preview   One of:
 *   {kind: "marker", id, u, v}, {kind: "measurePoints", id, points},
 *   {kind: "stroke", id, color, width, from, points} (the points after the first `from` numbers already sent),
 *   {kind: "strokeEnd", id, stroke|null}, {kind: "measure", points}, {kind: "measureEnd", measure|null}
 */
export function broadcastPreview(doc, preview) {
  game.socket.emit(EVENT, {action: "preview", uuid: doc.uuid, preview});
}

/**
 * Save what a driver changed (the camera, including auto-spin, the terrain's display style, and the map travelled
 * to: a map UUID, or null for home). GMs write directly; owners ask the active GM.
 * @param {TileDocument} doc
 * @param {{camera?: object, terrain?: {display: string}, map?: string|null}} changes
 */
export function saveDriverChanges(doc, changes) {
  if ( game.user.isGM ) return writeHolo(doc, sanitize(doc, changes));
  const gm = activeGM();
  if ( !gm ) return;
  game.socket.emit(EVENT, {action: "save", uuid: doc.uuid, changes}, {recipients: [gm.id]});
}

function onCamera({uuid, camera}, sender) {
  const doc = fromUuidSync(uuid, {strict: false});
  // The driven tile may be on another scene and still move a linked hologram on this one.
  if ( !doc || !canDrive(sender, doc) ) return;
  showLiveCamera(doc, pickCamera(camera), {smooth: true});
}

function onPreview({uuid, preview}, sender) {
  const doc = fromUuidSync(uuid, {strict: false});
  if ( !doc || !canDrive(sender, doc) ) return;
  const clean = sanitizePreview(preview);
  if ( clean ) showPreview(doc, sender.id, clean);
}

/** A preview with every field checked, or null. */
function sanitizePreview(preview) {
  const isId = id => (typeof id === "string") && /^[a-zA-Z0-9]{16}$/.test(id);
  const unit = n => (Number.isFinite(n) ? Math.clamp(n, 0, 1) : null);
  const units = (points, max) => {
    if ( !Array.isArray(points) || (points.length % 2) || (points.length > max) ) return null;
    const clean = points.map(unit);
    return clean.includes(null) ? null : clean;
  };
  const {kind, id} = preview ?? {};
  switch ( kind ) {
    case "marker": {
      const [u, v] = [unit(preview.u), unit(preview.v)];
      return (isId(id) && (u !== null) && (v !== null)) ? {kind, id, u, v} : null;
    }
    case "ping": {
      const [u, v] = [unit(preview.u), unit(preview.v)];
      const color = /^#[0-9a-f]{6}$/i.test(preview.color) ? preview.color : INKS[0];
      return ((u !== null) && (v !== null)) ? {kind, u, v, color} : null;
    }
    case "measurePoints": {
      const points = units(preview.points, 4);
      return (isId(id) && (points?.length === 4)) ? {kind, id, points} : null;
    }
    case "measure": {
      const points = units(preview.points, 4);
      return (points?.length === 4) ? {kind, points} : null;
    }
    case "stroke": {
      const points = units(preview.points, MAX_STROKE_POINTS * 2);
      const {from} = preview;
      const validFrom = Number.isInteger(from) && (from >= 0) && (from <= MAX_STROKE_POINTS * 40);
      if ( !isId(id) || !points || !validFrom ) return null;
      const color = /^#[0-9a-f]{6}$/i.test(preview.color) ? preview.color : INKS[0];
      const width = (preview.width in STROKE_WIDTHS) ? Number(preview.width) : 2;
      return {kind, id, color, width, from, points};
    }
    case "strokeEnd":
      return isId(id) ? {kind, id, stroke: preview.stroke ? sanitizeStroke(preview.stroke) : null} : null;
    case "measureEnd":
      return {kind, measure: preview.measure ? sanitizeMeasure(preview.measure) : null};
    default:
      return null;
  }
}

function onSave({uuid, changes}, sender) {
  if ( game.user !== game.users.activeGM ) return;
  const doc = fromUuidSync(uuid, {strict: false});
  if ( !doc || !canDrive(sender, doc) ) return;
  writeHolo(doc, sanitize(doc, changes));
}

function onAnnotations({uuid, list, edit}, sender) {
  if ( game.user !== game.users.activeGM ) return;
  const doc = fromUuidSync(uuid, {strict: false});
  if ( !doc || !canDrive(sender, doc) || !edit || (typeof edit !== "object") ) return;
  applyAnnotationEdit(doc, list, edit); // The list name and every field are checked there
}

/**
 * Only the fields a driver may change: camera numbers, a known display style, and travel to a neighbouring map
 * (the parent, a map placed on this one, or home).
 */
function sanitize(doc, {camera, terrain, map}={}) {
  const changes = {};
  if ( camera ) changes.camera = pickCamera(camera);
  if ( DISPLAY_MODES.includes(terrain?.display) ) changes.terrain = {display: terrain.display};
  const target = (map === undefined) ? undefined : travelTarget(doc, map);
  if ( target !== undefined ) changes.camera = {...changes.camera, map: target};
  return changes;
}

function pickCamera(camera={}) {
  const out = {};
  for ( const key of CAMERA_KEYS ) {
    if ( Number.isFinite(camera[key]) ) out[key] = camera[key];
  }
  // Spin toggles and drags keep adding to the yaw; keep the saved angle in one turn.
  if ( "yaw" in out ) out.yaw = ((out.yaw % TAU) + TAU) % TAU;
  return out;
}
