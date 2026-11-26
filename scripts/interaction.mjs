import {DEFAULTS, MARKER_GLYPHS, canDrive, contrastingInk, defaultCamera} from "./data.mjs";
import {editMarkers} from "./annotations.mjs";
import HoloConfig from "./holo-config.mjs";
import {MAX_DIST, MAX_PITCH, MIN_DIST, MIN_PITCH} from "./holo-renderer.mjs";
import {closeCard, isCardEvent, openCard, updateCard} from "./pin-card.mjs";
import {hideRing, isRingEvent, refreshRing, setGlyphOn, showRing} from "./ring.mjs";
import {getHolograms, showLiveCamera} from "./tile-holo.mjs";
import {broadcastCamera, saveDriverChanges} from "./socket.mjs";

/** Radians of yaw / pitch per screen pixel dragged. */
const ORBIT_SPEED = 0.008;
const PITCH_SPEED = 0.006;
const ZOOM_STEP = 1.12;
const BROADCAST_INTERVAL = 50;
const WHEEL_SAVE_DELAY = 400;
const DOUBLE_CLICK_MS = 350;
/** Movement (screen pixels) under which a press counts as a click rather than a drag. */
const CLICK_SLOP = 4;

/**
 * @type {{tile: Tile, holo: HoloRenderer, pointerId: number, pan: boolean, pressed: string|null,
 *         marker: string|null, x: number, y: number, start: object, camera: object, position: object|null,
 *         moved: boolean, lastSent: number}|null}
 */
let drag = null;
/**
 * The hologram the user last pressed on. It shows the tool ring, and the wheel zooms it while the pointer is over
 * it. Pressing anywhere else lets it go.
 */
let engaged = null;
/** While on, clicking the engaged hologram's surface places a waypoint. */
let waypointTool = false;
let lastClick = {tile: null, time: 0};
let wheelSave = null;

/**
 * Pointer handling runs in the capture phase on window, ahead of PIXI and Foundry's own canvas handlers, so a
 * press on a hologram never starts a selection box and the wheel never zooms the canvas while zooming a hologram.
 */
export function registerInteraction() {
  window.addEventListener("pointerdown", onPointerDown, {capture: true});
  window.addEventListener("pointermove", onPointerMove, {capture: true});
  window.addEventListener("pointerup", onPointerUp, {capture: true});
  window.addEventListener("pointercancel", onPointerUp, {capture: true});
  window.addEventListener("wheel", onWheel, {capture: true, passive: false});
  Hooks.on("refreshTile", tile => refreshRing(tile));
  Hooks.on("updateTile", doc => refreshRing(doc.object));
  Hooks.on("updateJournalEntry", () => refreshRing());
  Hooks.on("destroyTile", tile => {
    if ( tile === engaged ) setEngaged(null);
  });
  Hooks.on("canvasTearDown", () => setEngaged(null));
  Hooks.once("canvasReady", () => canvas.app.ticker.add(updateCard));
}

/** @param {{tile: Tile, holo: HoloRenderer}|null} hit */
function setEngaged(hit) {
  engaged = hit?.tile ?? null;
  waypointTool = false;
  closeCard();
  if ( !hit ) return hideRing();
  const {tile, holo} = hit;
  showRing(tile, {
    recenter: () => recenter(tile, holo),
    spin: () => toggleSpin(tile, holo),
    waypoint: () => {
      waypointTool = !waypointTool;
      setGlyphOn("waypoint", waypointTool);
    },
    settings: () => HoloConfig.open(tile.document)
  });
}

function swallow(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * The topmost hologram under the pointer that this user may drive, unless something interactive on the active
 * layer (a token, a drawing, ...) is under the pointer: those keep their normal behaviour.
 * @param {PointerEvent|WheelEvent} event
 * @returns {{tile: Tile, holo: HoloRenderer}|null}
 */
function hologramAt(event) {
  if ( !canvas?.ready || (event.target !== canvas.app.view) || canvas.tiles.active ) return null;
  const point = canvasPoint(event);
  let found = null;
  for ( const [tile, holo] of getHolograms() ) {
    if ( !holo.data.interactive || !tile.visible || !tile.mesh?.visible ) continue;
    if ( !canDrive(game.user, tile.document) || !insideProjection(tile, point) ) continue;
    if ( !game.user.isGM && !canvas.visibility.testVisibility(tile.center, {object: tile}) ) continue;
    if ( !found || isAbove(tile, found.tile) ) found = {tile, holo};
  }
  if ( !found || placeableAt(event) ) return null;
  return found;
}

function canvasPoint(event) {
  return canvas.canvasCoordinatesFromClient({x: event.clientX, y: event.clientY});
}

/** Is the canvas point inside the ellipse inscribed in the tile (the projection area)? */
function insideProjection(tile, point) {
  const {width, height, rotation} = tile.document;
  const center = tile.center;
  const angle = -Math.toRadians(rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const x = ((dx * Math.cos(angle)) - (dy * Math.sin(angle))) / (width / 2);
  const y = ((dx * Math.sin(angle)) + (dy * Math.cos(angle))) / (height / 2);
  return ((x * x) + (y * y)) <= 1;
}

function isAbove(a, b) {
  const elevation = a.document.elevation - b.document.elevation;
  return elevation ? (elevation > 0) : (a.document.sort > b.document.sort);
}

/** The placeable whose interactive area is under the pointer, according to PIXI's own hit testing. */
function placeableAt(event) {
  const events = canvas.app.renderer.events;
  const point = new PIXI.Point();
  events.mapPositionToPoint(point, event.clientX, event.clientY);
  const Placeable = foundry.canvas.placeables?.PlaceableObject ?? globalThis.PlaceableObject;
  for ( let target = events.rootBoundary.hitTest(point.x, point.y); target; target = target.parent ) {
    if ( target instanceof Placeable ) return target;
  }
  return null;
}

function onPointerDown(event) {
  if ( (event.button !== 0) || isRingEvent(event) || isCardEvent(event) ) return;
  const hit = hologramAt(event);
  if ( hit?.tile !== engaged ) setEngaged(hit);
  if ( !hit ) return;
  swallow(event);
  // Keep receiving the drag outside the window, and drop focus from inputs like a normal canvas click would.
  canvas.app.view.setPointerCapture(event.pointerId);
  if ( document.activeElement instanceof HTMLElement ) document.activeElement.blur();
  const {tile, holo} = hit;
  holo.dragging = true;
  // A pressed pin opens its card on click; it's only dragged when unlocked (a locked pin lets the drag orbit).
  const pressed = holo.markerAt(holo.toTexturePoint(canvasPoint(event)));
  const locked = !!holo.markers.find(m => m.id === pressed)?.locked;
  drag = {
    tile, holo,
    pointerId: event.pointerId,
    pan: event.shiftKey,
    pressed,
    marker: locked ? null : pressed,
    x: event.clientX,
    y: event.clientY,
    start: {...holo.camera},
    camera: {...holo.camera},
    position: null,
    moved: false,
    lastSent: 0
  };
}

function onPointerMove(event) {
  if ( !drag || (event.pointerId !== drag.pointerId) ) return;
  swallow(event);
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if ( !drag.moved && (Math.hypot(dx, dy) < CLICK_SLOP) ) return;
  drag.moved = true;
  const {start, camera, holo} = drag;

  // Dragging a waypoint slides it across the surface under the pointer.
  if ( drag.marker ) {
    const position = holo.surfaceAt(holo.toTexturePoint(canvasPoint(event)));
    if ( position ) {
      drag.position = position;
      holo.setLiveMarker(drag.marker, position);
    }
    return;
  }

  if ( drag.pan ) Object.assign(camera, panCamera(drag.tile, holo, start, dx, dy));
  else {
    camera.yaw = start.yaw - (dx * ORBIT_SPEED);
    camera.pitch = Math.clamp(start.pitch + (dy * PITCH_SPEED), MIN_PITCH, MAX_PITCH);
  }
  showLiveCamera(drag.tile.document, camera);
  const now = performance.now();
  if ( now - drag.lastSent >= BROADCAST_INTERVAL ) {
    drag.lastSent = now;
    broadcastCamera(drag.tile.document, camera);
  }
}

function onPointerUp(event) {
  if ( !drag || (event.pointerId !== drag.pointerId) ) return;
  swallow(event);
  const {tile, holo, camera, moved, pressed, marker, position} = drag;
  drag = null;
  holo.dragging = false;
  if ( tile.destroyed ) return; // Deleted, or the scene changed, mid-drag

  if ( pressed && !moved ) return openMarkerCard(tile, holo, pressed);
  if ( marker ) {
    if ( position ) editMarkers(tile.document, {type: "update", id: marker, changes: position});
    return;
  }
  if ( moved ) {
    broadcastCamera(tile.document, camera);
    saveDriverChanges(tile.document, {camera});
    return;
  }

  // A click on the hologram itself.
  if ( waypointTool ) return placeMarker(tile, holo, canvasPoint(event));
  closeCard();
  const now = performance.now();
  if ( (lastClick.tile === tile) && (now - lastClick.time < DOUBLE_CLICK_MS) ) {
    lastClick = {tile: null, time: 0};
    toggleSpin(tile, holo);
  }
  else lastClick = {tile, time: now};
}

/** Drop a new waypoint where the click meets the hologram's surface, and open its card. */
function placeMarker(tile, holo, point) {
  const position = holo.surfaceAt(holo.toTexturePoint(point));
  if ( !position ) return;
  const color = contrastingInk(holo.data.look.color);
  const marker = {id: foundry.utils.randomID(), ...position, label: "", glyph: MARKER_GLYPHS[0], color};
  editMarkers(tile.document, {type: "add", marker});
  openMarkerCard(tile, holo, marker.id);
}

function openMarkerCard(tile, holo, id) {
  openCard(tile, holo, id, {
    update: changes => editMarkers(tile.document, {type: "update", id, changes}),
    remove: () => editMarkers(tile.document, {type: "delete", id}),
    focus: () => {
      const marker = holo.markers.find(m => m.id === id);
      if ( !marker ) return;
      const camera = {...holo.camera, ...holo.surfaceTarget(marker.u, marker.v)};
      showLiveCamera(tile.document, camera);
      broadcastCamera(tile.document, camera);
      saveDriverChanges(tile.document, {camera});
    }
  });
}

/**
 * Move the camera target so the hologram follows the pointer across the floor.
 * Screen deltas are turned into camera-space floor deltas, then rotated back into footprint space.
 */
function panCamera(tile, holo, start, dx, dy) {
  const unitsPerPixel = 1 / (canvas.stage.scale.x * holo.sceneUnitsPerUnit(start.dist));
  const tileAngle = -Math.toRadians(tile.document.rotation);
  const sx = ((dx * Math.cos(tileAngle)) - (dy * Math.sin(tileAngle))) * unitsPerPixel;
  const sy = ((dx * Math.sin(tileAngle)) + (dy * Math.cos(tileAngle))) * unitsPerPixel;
  const cameraX = sx;
  const cameraFar = -sy / Math.max(Math.sin(start.pitch), 0.2);
  const yaw = holo.displayYaw;
  const x = (cameraX * Math.cos(yaw)) - (cameraFar * Math.sin(yaw));
  const z = (cameraX * Math.sin(yaw)) + (cameraFar * Math.cos(yaw));
  return {x: Math.clamp(start.x - x, -1, 1), z: Math.clamp(start.z - z, -1, 1)};
}

/** Go back to the mode's starting view. */
function recenter(tile, holo) {
  const camera = {...defaultCamera(holo.data.mode), spin: holo.camera.spin};
  showLiveCamera(tile.document, camera);
  broadcastCamera(tile.document, camera);
  saveDriverChanges(tile.document, {camera});
}

/** Stop or restart auto-spin, keeping the hologram where it currently is on screen. */
function toggleSpin(tile, holo) {
  const current = holo.camera;
  const spin = current.spin ? 0 : DEFAULTS.camera.spin;
  const yaw = current.yaw + holo.spinPhase(current.spin) - holo.spinPhase(spin);
  const camera = {...current, yaw, spin};
  showLiveCamera(tile.document, camera);
  broadcastCamera(tile.document, camera);
  saveDriverChanges(tile.document, {camera});
}

function onWheel(event) {
  if ( !engaged || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey ) return;
  const hit = hologramAt(event);
  if ( hit?.tile !== engaged ) return;
  swallow(event);
  const {tile, holo} = hit;
  const camera = {...holo.camera};
  camera.dist = Math.clamp(camera.dist * (ZOOM_STEP ** Math.sign(event.deltaY)), MIN_DIST, MAX_DIST);
  showLiveCamera(tile.document, camera);
  holo.dragging = true; // Hold the live zoom until it's saved
  broadcastCamera(tile.document, camera);
  clearTimeout(wheelSave);
  wheelSave = setTimeout(() => {
    holo.dragging = false;
    saveDriverChanges(tile.document, {camera});
  }, WHEEL_SAVE_DELAY);
}
