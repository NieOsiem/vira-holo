import {DEFAULTS, MARKER_GLYPHS, MAX_STROKES, MAX_STROKE_POINTS, canDrive, contrastingInk, defaultCamera} from "./data.mjs";
import {editAnnotations} from "./annotations.mjs";
import HoloConfig from "./holo-config.mjs";
import {MAX_DIST, MAX_PITCH, MIN_DIST, MIN_PITCH} from "./holo-renderer.mjs";
import {closeCard, isCardEvent, openCard, updateCard} from "./pin-card.mjs";
import {hideRing, isRingEvent, refreshRing, setGlyphOn, setStrip, showRing} from "./ring.mjs";
import {simplifyStroke} from "./stroke-layer.mjs";
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
/** Screen pixels the pointer moves before a stroke gets its next point. */
const STROKE_SPACING = 3;
/** How far (in image UV) a point may stray from a straight run before it's kept when a stroke is simplified. */
const STROKE_TOLERANCE = 0.001;

/**
 * @type {{tile: Tile, holo: HoloRenderer, pointerId: number, pan: boolean, pressed: string|null,
 *         marker: string|null, stroke: object|null, x: number, y: number, last: {x: number, y: number},
 *         start: object, camera: object, position: object|null, moved: boolean, lastSent: number}|null}
 */
let drag = null;
/**
 * The hologram the user last pressed on. It shows the tool ring, and the wheel zooms it while the pointer is over
 * it. Pressing anywhere else lets it go.
 */
let engaged = null;
/**
 * The engaged hologram's active tool: "waypoint" (a click places a pin), "draw" (a drag inks the surface) or null.
 * @type {string|null}
 */
let tool = null;
/** Ink this client picked for new pins and strokes; null uses the one that stands out most on the hologram. */
let ink = null;
let strokeWidth = 2;
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
  tool = null;
  closeCard();
  if ( !hit ) return hideRing();
  const {tile, holo} = hit;
  showRing(tile, {
    recenter: () => recenter(tile, holo),
    spin: () => toggleSpin(tile, holo),
    waypoint: () => toggleTool("waypoint", holo),
    draw: () => toggleTool("draw", holo),
    settings: () => HoloConfig.open(tile.document)
  });
}

/** Switch a ring tool on (switching the other off) or off, with the ink strip under it while on. */
function toggleTool(name, holo) {
  tool = (tool === name) ? null : name;
  setGlyphOn("waypoint", tool === "waypoint");
  setGlyphOn("draw", tool === "draw");
  if ( !tool ) return setStrip(null);
  setStrip({
    glyph: tool,
    ink: currentInk(holo),
    width: (tool === "draw") ? strokeWidth : undefined,
    onInk: color => ink = color,
    onWidth: width => strokeWidth = width
  });
}

function currentInk(holo) {
  return ink ?? contrastingInk(holo.data.look.color);
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
  // With the pen, a press on the surface starts a stroke (pins underneath are drawn over, not picked).
  const stroke = ((tool === "draw") && !event.shiftKey) ? startStroke(holo, canvasPoint(event)) : null;
  // A pressed pin opens its card on click; it's only dragged when unlocked (a locked pin lets the drag orbit).
  const pressed = stroke ? null : holo.markerAt(holo.toTexturePoint(canvasPoint(event)));
  const locked = !!holo.markers.find(m => m.id === pressed)?.locked;
  drag = {
    tile, holo,
    pointerId: event.pointerId,
    pan: event.shiftKey,
    pressed,
    marker: locked ? null : pressed,
    stroke,
    x: event.clientX,
    y: event.clientY,
    last: {x: event.clientX, y: event.clientY},
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
  if ( drag.stroke ) return extendStroke(event);
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
  const {tile, holo, camera, moved, pressed, marker, position, stroke} = drag;
  drag = null;
  holo.dragging = false;
  if ( stroke ) holo.setLiveStroke(null);
  if ( tile.destroyed ) return; // Deleted, or the scene changed, mid-drag

  if ( stroke ) return finishStroke(tile, holo, stroke);
  if ( pressed && !moved ) return openMarkerCard(tile, holo, pressed);
  if ( marker ) {
    if ( position ) editAnnotations(tile.document, "markers", {type: "update", id: marker, changes: position});
    return;
  }
  if ( moved ) {
    broadcastCamera(tile.document, camera);
    saveDriverChanges(tile.document, {camera});
    return;
  }

  // A click on the hologram itself.
  if ( tool === "waypoint" ) return placeMarker(tile, holo, canvasPoint(event));
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
  const marker = {id: foundry.utils.randomID(), ...position, label: "", glyph: MARKER_GLYPHS[0], color: currentInk(holo)};
  editAnnotations(tile.document, "markers", {type: "add", item: marker});
  openMarkerCard(tile, holo, marker.id);
}

/**
 * Begin a stroke where a press meets the surface.
 * @returns {object|null}   Null off the surface (the press orbits instead) or when the hologram is full
 */
function startStroke(holo, point) {
  const position = holo.surfaceAt(holo.toTexturePoint(point));
  if ( !position ) return null;
  if ( holo.data.annotations.strokes.length >= MAX_STROKES ) {
    ui.notifications.warn(game.i18n.format("VIRAHOLO.StrokeLimit", {max: MAX_STROKES}));
    return null;
  }
  const stroke = {id: foundry.utils.randomID(), color: currentInk(holo), width: strokeWidth, points: [position.u, position.v]};
  holo.setLiveStroke(stroke);
  return stroke;
}

/** Add the pointer's surface point to the stroke being drawn, every few screen pixels. */
function extendStroke(event) {
  const {holo, stroke, last} = drag;
  if ( Math.hypot(event.clientX - last.x, event.clientY - last.y) < STROKE_SPACING ) return;
  if ( stroke.points.length >= MAX_STROKE_POINTS * 20 ) return; // Raw points; far fewer survive simplifying
  // Off the surface (past its edge) the stroke waits for the pointer to come back.
  const position = holo.surfaceAt(holo.toTexturePoint(canvasPoint(event)));
  if ( !position ) return;
  drag.last = {x: event.clientX, y: event.clientY};
  stroke.points.push(position.u, position.v);
  holo.setLiveStroke(stroke);
}

/** Save a finished stroke, simplified, and keep showing it until the save comes back. A plain click draws nothing. */
function finishStroke(tile, holo, stroke) {
  if ( stroke.points.length < 4 ) return;
  stroke.points = simplifyStroke(stroke.points, STROKE_TOLERANCE, MAX_STROKE_POINTS);
  holo.addPendingStroke(stroke);
  editAnnotations(tile.document, "strokes", {type: "add", item: stroke});
}

function openMarkerCard(tile, holo, id) {
  openCard(tile, holo, id, {
    update: changes => editAnnotations(tile.document, "markers", {type: "update", id, changes}),
    remove: () => editAnnotations(tile.document, "markers", {type: "delete", id}),
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
