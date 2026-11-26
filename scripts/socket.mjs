import {MODULE_ID, canDrive} from "./data.mjs";
import {applyMarkerEdit} from "./annotations.mjs";
import {getHolograms} from "./tile-holo.mjs";

const EVENT = `module.${MODULE_ID}`;
const CAMERA_KEYS = ["yaw", "pitch", "dist", "x", "z"];
const TAU = Math.PI * 2;

export function registerSocket() {
  // The server appends the sender's user ID, so it can be trusted (unlike anything inside the message).
  game.socket.on(EVENT, (message, senderId) => {
    const sender = game.users.get(senderId);
    if ( message?.action === "camera" ) onCamera(message, sender);
    else if ( message?.action === "save" ) onSave(message, sender);
    else if ( message?.action === "markers" ) onMarkers(message, sender);
  });
}

/** The active GM, or null with a warning to the user when no GM is connected to save changes. */
function activeGM() {
  const gm = game.users.activeGM;
  if ( !gm ) ui.notifications.warn("VIRAHOLO.NoActiveGM", {localize: true});
  return gm;
}

/**
 * Ask the active GM to apply a waypoint edit.
 * @param {TileDocument} doc
 * @param {import("./annotations.mjs").MarkerEdit} edit
 */
export function requestMarkerEdit(doc, edit) {
  const gm = activeGM();
  if ( gm ) game.socket.emit(EVENT, {action: "markers", uuid: doc.uuid, edit}, {recipients: [gm.id]});
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
 * Save what a driver changed (camera and auto-spin). GMs write directly; owners ask the active GM to write it.
 * @param {TileDocument} doc
 * @param {{camera?: object, spin?: number}} changes
 */
export function saveDriverChanges(doc, changes) {
  const update = sanitize(changes);
  if ( game.user.isGM ) return doc.update({[`flags.${MODULE_ID}`]: update});
  const gm = activeGM();
  if ( !gm ) return;
  game.socket.emit(EVENT, {action: "save", uuid: doc.uuid, changes}, {recipients: [gm.id]});
}

function onCamera({uuid, camera}, sender) {
  const doc = fromUuidSync(uuid);
  if ( !doc?.object || !canDrive(sender, doc) ) return;
  getHolograms().get(doc.object)?.setLiveCamera(pickCamera(camera));
}

function onSave({uuid, changes}, sender) {
  if ( game.user !== game.users.activeGM ) return;
  const doc = fromUuidSync(uuid);
  if ( !doc || !canDrive(sender, doc) ) return;
  doc.update({[`flags.${MODULE_ID}`]: sanitize(changes)});
}

function onMarkers({uuid, edit}, sender) {
  if ( game.user !== game.users.activeGM ) return;
  const doc = fromUuidSync(uuid);
  if ( !doc || !canDrive(sender, doc) || (typeof edit !== "object") ) return;
  applyMarkerEdit(doc, edit); // Every field is sanitized there
}

/** Only the fields a driver may change, and only as finite numbers. */
function sanitize({camera, spin}={}) {
  const update = {};
  if ( camera ) update.camera = pickCamera(camera);
  if ( Number.isFinite(spin) ) update.look = {spin};
  return update;
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
