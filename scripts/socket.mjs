import {MODULE_ID, canDrive} from "./data.mjs";
import {applyAnnotationEdit} from "./annotations.mjs";
import {writeHolo} from "./links.mjs";
import {showLiveCamera} from "./tile-holo.mjs";

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
 * Save what a driver changed (the camera, including auto-spin). GMs write directly; owners ask the active GM.
 * @param {TileDocument} doc
 * @param {{camera: object}} changes
 */
export function saveDriverChanges(doc, changes) {
  if ( game.user.isGM ) return writeHolo(doc, sanitize(changes));
  const gm = activeGM();
  if ( !gm ) return;
  game.socket.emit(EVENT, {action: "save", uuid: doc.uuid, changes}, {recipients: [gm.id]});
}

function onCamera({uuid, camera}, sender) {
  const doc = fromUuidSync(uuid, {strict: false});
  // The driven tile may be on another scene and still move a linked hologram on this one.
  if ( !doc || !canDrive(sender, doc) ) return;
  showLiveCamera(doc, pickCamera(camera));
}

function onSave({uuid, changes}, sender) {
  if ( game.user !== game.users.activeGM ) return;
  const doc = fromUuidSync(uuid, {strict: false});
  if ( !doc || !canDrive(sender, doc) ) return;
  writeHolo(doc, sanitize(changes));
}

function onAnnotations({uuid, list, edit}, sender) {
  if ( game.user !== game.users.activeGM ) return;
  const doc = fromUuidSync(uuid, {strict: false});
  if ( !doc || !canDrive(sender, doc) || !edit || (typeof edit !== "object") ) return;
  applyAnnotationEdit(doc, list, edit); // The list name and every field are checked there
}

/** Only the fields a driver may change, and only as finite numbers. */
function sanitize({camera}={}) {
  return camera ? {camera: pickCamera(camera)} : {};
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
