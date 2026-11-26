import {DEFAULTS, DISPLAY_MODES, MARKER_GLYPHS, MAX_MEASURES, MAX_STROKES, MAX_STROKE_POINTS, canDrive, contrastingInk,
  defaultCamera, sanitizeScale} from "./data.mjs";
import * as history from "./history.mjs";
import HoloConfig from "./holo-config.mjs";
import {MAX_DIST, MAX_PITCH, MIN_DIST, MIN_PITCH} from "./holo-renderer.mjs";
import {closeCard, isCardEvent, openCard, updateCard} from "./pin-card.mjs";
import {closeMeasureCard, isMeasureCardEvent, openMeasureCard, updateMeasureCard} from "./measure-card.mjs";
import {writeHolo} from "./links.mjs";
import {arrivalCamera, moveMap, updatePortal} from "./maps.mjs";
import {hideRing, isRingEvent, refreshRing, setGlyphEnabled, setGlyphOn, setStrip, showRing} from "./ring.mjs";
import {simplifyStroke} from "./stroke-layer.mjs";
import {getHolograms, showLiveCamera} from "./tile-holo.mjs";
import {broadcastCamera, broadcastPreview, saveDriverChanges} from "./socket.mjs";

/** Radians of yaw / pitch per screen pixel dragged. */
const ORBIT_SPEED = 0.008;
const PITCH_SPEED = 0.006;
const ZOOM_STEP = 1.12;
/** Milliseconds between live updates (camera, edits in progress) sent to other users: 30 per second. */
const BROADCAST_INTERVAL = 33;
const WHEEL_SAVE_DELAY = 400;
/** Entering a map first pans and zooms onto its portal for this long, then switches the map. */
const ENTER_MS = 550;
/** Camera distance when the view arrives at the portal, as a fraction of the starting one. */
const ENTER_ZOOM = 0.7;
const DOUBLE_CLICK_MS = 350;
/** Movement (screen pixels) under which a press counts as a click rather than a drag. */
const CLICK_SLOP = 4;
/** Reach of the eraser around the pointer, in screen pixels (on top of the stroke's own width). */
const ERASER_RADIUS = 8;
/** Screen pixels the pointer moves before a stroke gets its next point. */
const STROKE_SPACING = 3;
/** How far (in image UV) a point may stray from a straight run before it's kept when a stroke is simplified. */
const STROKE_TOLERANCE = 0.001;

/**
 * @type {{tile: Tile, holo: HoloRenderer, pointerId: number, pan: boolean, pressed: string|null,
 *         marker: string|null, label: string|null, toolOn: boolean, pen: boolean, stroke: object|null,
 *         measure: {a: object, b: object, second: boolean}|null,
 *         measureEnd: {id: string, end: number, points: number[]}|null,
 *         erasing: {x: number, y: number}|null, x: number, y: number, last: {x: number, y: number},
 *         start: object, camera: object, position: object|null, moved: boolean, lastSent: number}|null}
 */
let drag = null;
/** Whether the lead-in to entering a map is running (see zoomOnto). */
let entering = false;
/**
 * The hologram the user last pressed on. It shows the tool ring, and the wheel zooms it while the pointer is over
 * it. Pressing anywhere else lets it go.
 */
let engaged = null;
/**
 * The engaged hologram's active tool: "waypoint" (a click places a pin), "draw" (a drag inks the surface),
 * "erase" (a click or drag removes the strokes and measurements under it), "measure" (drag, or click twice, between
 * two points), "adjust" (the measure glyph's second mode: drag measurement ends) or null.
 * @type {string|null}
 */
let tool = null;
/** Ink this client picked for new pins and strokes; null uses the one that stands out most on the hologram. */
let ink = null;
let strokeWidth = 2;
/** Where a click-click measurement started ({u, v}), waiting for its second click. */
let measureStart = null;
/** The tile whose measurement in progress other users are being shown, so they can be told when it ends. */
let measurePreviewTile = null;
let lastPreview = 0;
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
  window.addEventListener("keydown", onKeyDown, {capture: true});
  Hooks.on("refreshTile", tile => refreshRing(tile));
  Hooks.on("updateTile", doc => refreshRing(doc.object));
  Hooks.on("updateJournalEntry", () => refreshRing());
  Hooks.on("destroyTile", tile => {
    if ( tile === engaged ) setEngaged(null);
  });
  Hooks.on("canvasTearDown", () => setEngaged(null));
  history.onHistoryChange(refreshHistoryGlyphs);
  Hooks.once("canvasReady", () => {
    canvas.app.ticker.add(updateCard);
    canvas.app.ticker.add(updateMeasureCard);
  });
}

/** @param {{tile: Tile, holo: HoloRenderer}|null} hit */
function setEngaged(hit) {
  cancelMeasure();
  engaged = hit?.tile ?? null;
  tool = null;
  closeCards();
  if ( !hit ) return hideRing();
  const {tile, holo} = hit;
  showRing(tile, {
    up: () => travel(tile, holo, holo.data.map.parent?.uuid),
    recenter: () => recenter(tile, holo),
    spin: () => toggleSpin(tile, holo),
    display: () => cycleDisplay(tile, holo),
    waypoint: () => toggleTool("waypoint", holo),
    draw: () => toggleTool("draw", holo),
    erase: () => toggleTool("erase", holo),
    // The ruler has two modes: off → making measurements → moving their ends → off.
    measure: () => setTool((tool === "measure") ? "adjust" : ((tool === "adjust") ? null : "measure"), holo),
    undo: () => history.undo(tile.document),
    redo: () => history.redo(tile.document),
    settings: () => HoloConfig.open(tile.document)
  });
  refreshHistoryGlyphs();
}

/** Dim undo and redo when there's nothing to take back or do again on the engaged hologram. */
function refreshHistoryGlyphs() {
  if ( !engaged ) return;
  setGlyphEnabled("undo", history.canUndo(engaged.document));
  setGlyphEnabled("redo", history.canRedo(engaged.document));
}

/** Switch a ring tool on (switching the others off), or off if it already is. */
function toggleTool(name, holo) {
  setTool((tool === name) ? null : name, holo);
}

/** Make a tool the active one (or none), lighting its glyph, with the ink strip under it for pins and the pen. */
function setTool(name, holo) {
  cancelMeasure();
  tool = name;
  for ( const glyph of ["waypoint", "draw", "erase"] ) setGlyphOn(glyph, tool === glyph);
  setGlyphOn("measure", ["measure", "adjust"].includes(tool), (tool === "adjust") ? 2 : 1);
  if ( !["waypoint", "draw"].includes(tool) ) return setStrip(null);
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

function closeCards() {
  closeCard();
  closeMeasureCard();
}

/** Drop a measurement waiting for its second click. */
function cancelMeasure() {
  measureStart = null;
  if ( engaged ) getHolograms().get(engaged)?.setLiveMeasure(null);
  endMeasurePreview(null);
}

/**
 * Show other users an edit in progress, at most every BROADCAST_INTERVAL unless forced (first and last messages).
 * @returns {boolean}   Whether it was sent
 */
function sendPreview(tile, preview, force=false) {
  const now = performance.now();
  if ( !force && (now - lastPreview < BROADCAST_INTERVAL) ) return false;
  lastPreview = now;
  broadcastPreview(tile.document, preview);
  return true;
}

/** Tell other users this client's measurement in progress ended, with the measurement it saved, if any. */
function endMeasurePreview(measure) {
  if ( !measurePreviewTile ) return;
  if ( !measurePreviewTile.destroyed ) sendPreview(measurePreviewTile, {kind: "measureEnd", measure}, true);
  measurePreviewTile = null;
}

function onKeyDown(event) {
  if ( (event.key !== "Escape") || !measureStart ) return;
  event.preventDefault();
  event.stopImmediatePropagation(); // Don't also deselect or close windows
  cancelMeasure();
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
  // v12 declares PlaceableObject as a top-level class: a global binding, but not a property of globalThis.
  const Placeable = foundry.canvas.placeables?.PlaceableObject ?? PlaceableObject;
  for ( let target = events.rootBoundary.hitTest(point.x, point.y); target; target = target.parent ) {
    if ( target instanceof Placeable ) return target;
  }
  return null;
}

function onPointerDown(event) {
  if ( (event.button !== 0) || isRingEvent(event) || isCardEvent(event) || isMeasureCardEvent(event) ) return;
  const hit = hologramAt(event);
  if ( hit?.tile !== engaged ) setEngaged(hit);
  if ( !hit ) return;
  swallow(event);
  // Keep receiving the drag outside the window, and drop focus from inputs like a normal canvas click would.
  canvas.app.view.setPointerCapture(event.pointerId);
  if ( document.activeElement instanceof HTMLElement ) document.activeElement.blur();
  const {tile, holo} = hit;
  holo.dragging = true;
  // With a tool on, a drag is the tool's: it never orbits (Shift+drag still pans). The pen and the eraser ignore pins.
  let pen = (tool === "draw") && !event.shiftKey;
  if ( pen && (holo.data.annotations.strokes.length >= MAX_STROKES) ) {
    ui.notifications.warn(game.i18n.format("VIRAHOLO.StrokeLimit", {max: MAX_STROKES}));
    pen = false;
  }
  const texturePoint = holo.toTexturePoint(canvasPoint(event));
  const erasing = ((tool === "erase") && !event.shiftKey) ? texturePoint : null;
  if ( erasing ) {
    history.beginGroup(tile.document); // One scrub is one undo step
    eraseAlong(tile, holo, erasing, erasing);
  }
  // A pressed pin opens its card on click; it's only dragged when unlocked (a locked pin lets the drag orbit).
  const pressed = ["draw", "erase", "measure", "adjust"].includes(tool) ? null : holo.markerAt(texturePoint);
  // Portals belong to their map's journal: players can never drag them.
  const pressedMarker = holo.markers.find(m => m.id === pressed);
  const locked = !!pressedMarker?.locked || (!!pressedMarker?.portal && !game.user.isGM);
  // In the ruler's second mode, a press on a measurement's end dot grabs it.
  const end = ((tool === "adjust") && !event.shiftKey) ? holo.measureEndAt(texturePoint) : null;
  const measureEnd = end && grabMeasureEnd(holo, end);
  // A measurement's label opens its card on click, without a tool or with the ruler (unless mid-measurement).
  const canOpenLabel = !pressed && !measureEnd
    && ((tool === null) || (tool === "adjust") || ((tool === "measure") && !measureStart));
  const label = canOpenLabel ? holo.measureAt(texturePoint) : null;
  const measuring = (tool === "measure") && !event.shiftKey && !label;
  const measure = measuring ? startMeasure(tile, holo, texturePoint) : null;
  drag = {
    tile, holo,
    pointerId: event.pointerId,
    pan: event.shiftKey,
    pressed,
    marker: locked ? null : pressed,
    label,
    measure,
    measureEnd,
    toolOn: !!tool,
    pen,
    stroke: pen ? startStroke(tile, holo, canvasPoint(event)) : null,
    erasing,
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
  if ( !drag ) return hoverMeasure(event);
  if ( event.pointerId !== drag.pointerId ) return;
  swallow(event);
  if ( drag.pen ) return extendStroke(event);
  if ( drag.erasing ) {
    const point = drag.holo.toTexturePoint(canvasPoint(event));
    eraseAlong(drag.tile, drag.holo, drag.erasing, point);
    drag.erasing = point;
    return;
  }
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if ( !drag.moved && (Math.hypot(dx, dy) < CLICK_SLOP) ) return;
  drag.moved = true;
  const {start, camera, holo} = drag;
  if ( drag.measure ) return moveMeasureEnd(drag.tile, holo, drag.measure, canvasPoint(event));
  if ( drag.measureEnd ) return dragMeasureEnd(drag.tile, holo, drag.measureEnd, canvasPoint(event));

  // Dragging a waypoint slides it across the surface under the pointer.
  if ( drag.marker ) {
    const position = holo.surfaceAt(holo.toTexturePoint(canvasPoint(event)));
    if ( position ) {
      drag.position = position;
      holo.setLiveMarker(drag.marker, position);
      sendPreview(drag.tile, {kind: "marker", id: drag.marker, ...position});
    }
    return;
  }
  if ( drag.toolOn && !drag.pan ) return;

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
  const {tile, holo, camera, moved, pressed, marker, label, measure, measureEnd, position, pan, toolOn, pen, stroke,
    erasing} = drag;
  drag = null;
  holo.dragging = false;
  if ( stroke ) holo.setLiveStroke(null);
  if ( erasing ) history.endGroup();
  if ( tile.destroyed ) return; // Deleted, or the scene changed, mid-drag

  if ( stroke ) return finishStroke(tile, holo, stroke);
  if ( pen || erasing ) return;
  if ( measure ) return finishMeasure(tile, holo, measure, moved);
  if ( measureEnd ) {
    const {id, points} = measureEnd;
    // The moved points stay on show until the save comes back (see HoloRenderer#configure).
    if ( moved ) {
      history.edit(tile.document, "measures", {type: "update", id, changes: {points}},
        holo.data.annotations.measures.find(m => m.id === id));
    }
    else holo.setLiveMeasurePoints(id, null);
    return;
  }
  if ( label && !moved ) return openMeasure(tile, holo, label);
  const portal = pressed && holo.markers.find(m => m.id === pressed)?.portal;
  if ( pressed && !moved ) return portal ? openPortalCard(tile, holo, pressed, portal) : openMarkerCard(tile, holo, pressed);
  if ( marker ) {
    if ( portal ) {
      // The moved portal stays on show until the map's new spot is saved (see HoloRenderer#configure).
      if ( position ) moveMap(portal, position);
      return;
    }
    if ( position ) {
      history.edit(tile.document, "markers", {type: "update", id: marker, changes: position},
        holo.annotation("markers", marker));
    }
    return;
  }
  if ( moved ) {
    if ( toolOn && !pan ) return; // The camera didn't move
    broadcastCamera(tile.document, camera);
    saveDriverChanges(tile.document, {camera});
    return;
  }

  // A click on the hologram itself; with a tool on it never toggles auto-spin.
  if ( tool === "waypoint" ) return placeMarker(tile, holo, canvasPoint(event));
  if ( toolOn ) return;
  closeCards();
  const now = performance.now();
  if ( (lastClick.tile === tile) && (now - lastClick.time < DOUBLE_CLICK_MS) ) {
    lastClick = {tile: null, time: 0};
    toggleSpin(tile, holo);
  }
  else lastClick = {tile, time: now};
}

/**
 * Show another map on the hologram: its parent, or a map placed on it. Everyone watching sees it, like the camera.
 * @param {Tile} tile
 * @param {HoloRenderer} holo
 * @param {string} [uuid]
 */
async function travel(tile, holo, uuid) {
  if ( !uuid || entering ) return;
  setTool(null, holo); // The ring is rebuilt for the new map
  closeCards();
  const portal = holo.data.map.children.find(c => c.uuid === uuid);
  if ( portal ) await zoomOnto(tile, holo, portal);
  if ( tile.destroyed ) return;
  const camera = await arrivalCamera(holo.data, uuid);
  saveDriverChanges(tile.document, {camera, map: uuid});
}

/**
 * Ease the camera onto a portal and a little closer, as the lead-in to entering its map. Everyone watching sees it
 * as a live camera.
 */
async function zoomOnto(tile, holo, {u, v}) {
  const from = {...holo.camera};
  const to = {...from, ...holo.surfaceTarget(u, v), dist: Math.max(from.dist * ENTER_ZOOM, MIN_DIST)};
  entering = true;
  holo.dragging = true; // Hold the live camera, whatever saved updates arrive meanwhile
  try {
    const start = performance.now();
    let lastSent = 0;
    for ( let t = 0; t < 1; ) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if ( tile.destroyed ) return;
      const now = performance.now();
      t = Math.min((now - start) / ENTER_MS, 1);
      const eased = t * t * (3 - (2 * t));
      const camera = {...from};
      for ( const key of ["x", "z", "dist"] ) camera[key] = from[key] + ((to[key] - from[key]) * eased);
      showLiveCamera(tile.document, camera);
      if ( (now - lastSent >= BROADCAST_INTERVAL) || (t >= 1) ) {
        lastSent = now;
        broadcastCamera(tile.document, camera);
      }
    }
  }
  finally {
    entering = false;
    holo.dragging = false;
  }
}

/** Drop a new waypoint where the click meets the hologram's surface, and open its card. */
function placeMarker(tile, holo, point) {
  const position = holo.surfaceAt(holo.toTexturePoint(point));
  if ( !position ) return;
  const marker = {id: foundry.utils.randomID(), ...position, label: "", glyph: MARKER_GLYPHS[0], color: currentInk(holo)};
  history.edit(tile.document, "markers", {type: "add", item: marker});
  openMarkerCard(tile, holo, marker.id);
}

/**
 * Begin a stroke where the pointer meets the surface, and start showing it to other users.
 * @returns {object|null}   Null off the surface
 */
function startStroke(tile, holo, point) {
  const position = holo.surfaceAt(holo.toTexturePoint(point));
  if ( !position ) return null;
  const stroke = {id: foundry.utils.randomID(), color: currentInk(holo), width: strokeWidth,
    points: [position.u, position.v], sent: 0};
  holo.setLiveStroke(stroke);
  sendStrokePoints(tile, stroke, true);
  return stroke;
}

/** Send other users the stroke's points they haven't had yet. */
function sendStrokePoints(tile, stroke, force=false) {
  const {id, color, width, points, sent} = stroke;
  if ( sendPreview(tile, {kind: "stroke", id, color, width, from: sent, points: points.slice(sent)}, force) ) {
    stroke.sent = points.length;
  }
}

/**
 * Add the pointer's surface point to the stroke being drawn, every few screen pixels. A drag that began off the
 * surface starts its stroke once the pointer reaches it.
 */
function extendStroke(event) {
  const {tile, holo, stroke, last} = drag;
  if ( !stroke ) {
    drag.stroke = startStroke(tile, holo, canvasPoint(event));
    drag.last = {x: event.clientX, y: event.clientY};
    return;
  }
  if ( Math.hypot(event.clientX - last.x, event.clientY - last.y) < STROKE_SPACING ) return;
  if ( stroke.points.length >= MAX_STROKE_POINTS * 20 ) return; // Raw points; far fewer survive simplifying
  // Off the surface (past its edge) the stroke waits for the pointer to come back.
  const position = holo.surfaceAt(holo.toTexturePoint(canvasPoint(event)));
  if ( !position ) return;
  drag.last = {x: event.clientX, y: event.clientY};
  stroke.points.push(position.u, position.v);
  holo.setLiveStroke(stroke);
  sendStrokePoints(tile, stroke);
}

/**
 * Remove every stroke the eraser passes over between two render-texture points. They vanish here at once; the
 * deletion is saved through the GM.
 */
function eraseAlong(tile, holo, from, to) {
  if ( tile.destroyed ) return;
  const texelsPerPixel = (holo.width / tile.document.width) / canvas.stage.scale.x;
  for ( const {list, id} of holo.annotationsAlong(from, to, ERASER_RADIUS * texelsPerPixel) ) {
    const before = holo.annotation(list, id);
    holo.hide(list, id);
    history.edit(tile.document, list, {type: "delete", id}, before);
  }
}

/** Save a finished stroke, simplified, and keep showing it until the save comes back. A plain click draws nothing. */
function finishStroke(tile, holo, {id, color, width, points}) {
  const stroke = (points.length < 4) ? null
    : {id, color, width, points: simplifyStroke(points, STROKE_TOLERANCE, MAX_STROKE_POINTS)};
  sendPreview(tile, {kind: "strokeEnd", id, stroke}, true);
  if ( !stroke ) return;
  holo.addPending("strokes", stroke);
  history.edit(tile.document, "strokes", {type: "add", item: stroke});
}

/**
 * Begin a measurement at a press on the surface, or finish one waiting for its second click there.
 * @returns {{a: object, b: object, second: boolean}|null}   Null off the surface or when the hologram is full
 */
function startMeasure(tile, holo, texturePoint) {
  const point = holo.surfaceAt(texturePoint);
  if ( !point ) return null;
  if ( !measureStart && (holo.data.annotations.measures.length >= MAX_MEASURES) ) {
    ui.notifications.warn(game.i18n.format("VIRAHOLO.MeasureLimit", {max: MAX_MEASURES}));
    return null;
  }
  const measure = {a: measureStart ?? point, b: point, second: !!measureStart};
  showMeasure(tile, holo, measure, true);
  return measure;
}

/** Show the measurement in progress here and (every so often, or now if forced) to other users. */
function showMeasure(tile, holo, {a, b}, force=false) {
  const points = [a.u, a.v, b.u, b.v];
  holo.setLiveMeasure({points});
  measurePreviewTile = tile;
  sendPreview(tile, {kind: "measure", points}, force);
}

/** Move the measurement's end to the surface under a canvas point (it stays put off the surface). */
function moveMeasureEnd(tile, holo, measure, point) {
  const end = holo.surfaceAt(holo.toTexturePoint(point));
  if ( !end ) return;
  measure.b = end;
  showMeasure(tile, holo, measure);
}

/** While a measurement waits for its second click, its end follows the pointer. */
function hoverMeasure(event) {
  if ( !measureStart || !engaged || (event.target !== canvas.app?.view) ) return;
  const holo = getHolograms().get(engaged);
  if ( holo ) moveMeasureEnd(engaged, holo, {a: measureStart, b: measureStart}, canvasPoint(event));
}

/**
 * A drag, or a second click, saves the measurement; a first click leaves it waiting for the second.
 */
function finishMeasure(tile, holo, {a, b, second}, moved) {
  if ( !second && !moved ) {
    measureStart = a;
    return;
  }
  const measure = (Math.hypot(b.u - a.u, b.v - a.v) < 1e-3) ? null
    : {id: foundry.utils.randomID(), points: [a.u, a.v, b.u, b.v]};
  endMeasurePreview(measure);
  cancelMeasure();
  if ( !measure ) return;
  holo.addPending("measures", measure);
  history.edit(tile.document, "measures", {type: "add", item: measure});
}

/** Start moving one end of a measurement. */
function grabMeasureEnd(holo, {id, end}) {
  const measure = holo.data.annotations.measures.find(m => m.id === id);
  return measure ? {id, end, points: [...measure.points]} : null;
}

/** Slide the grabbed end across the surface under the pointer (it stays put off the surface). */
function dragMeasureEnd(tile, holo, measureEnd, point) {
  const position = holo.surfaceAt(holo.toTexturePoint(point));
  if ( !position ) return;
  measureEnd.points.splice(measureEnd.end * 2, 2, position.u, position.v);
  holo.setLiveMeasurePoints(measureEnd.id, [...measureEnd.points]);
  sendPreview(tile, {kind: "measurePoints", id: measureEnd.id, points: [...measureEnd.points]});
}

function openMeasure(tile, holo, id) {
  closeCard();
  openMeasureCard(tile, holo, id, {
    remove: () => {
      const before = holo.annotation("measures", id);
      holo.hide("measures", id);
      history.edit(tile.document, "measures", {type: "delete", id}, before);
    },
    // The scale is part of the hologram's settings, so only GMs change it.
    calibrate: game.user.isGM ? (distance, unit) => {
      const measure = holo.data.annotations.measures.find(m => m.id === id);
      const scale = measure && sanitizeScale(holo.scaleFrom(measure.points, distance, unit));
      if ( scale ) writeHolo(tile.document, {scale});
    } : undefined
  });
}

function openMarkerCard(tile, holo, id) {
  closeMeasureCard();
  openCard(tile, holo, id, {
    update: changes => history.edit(tile.document, "markers", {type: "update", id, changes},
      holo.annotation("markers", id)),
    remove: () => history.edit(tile.document, "markers", {type: "delete", id}, holo.annotation("markers", id)),
    focus: () => focusMarker(tile, holo, id)
  });
}

/** A portal's card: enter its map, focus it, and (GMs) rename the map or restyle the portal. */
function openPortalCard(tile, holo, id, uuid) {
  closeMeasureCard();
  openCard(tile, holo, id, {
    update: changes => updatePortal(uuid, changes),
    enter: () => travel(tile, holo, uuid),
    focus: () => focusMarker(tile, holo, id)
  }, {portal: true});
}

/** Centre the view on a waypoint or portal. */
function focusMarker(tile, holo, id) {
  const marker = holo.markers.find(m => m.id === id);
  if ( !marker ) return;
  const camera = {...holo.camera, ...holo.surfaceTarget(marker.u, marker.v)};
  showLiveCamera(tile.document, camera);
  broadcastCamera(tile.document, camera);
  saveDriverChanges(tile.document, {camera});
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

/** Switch the terrain to the next display style (see-through or opaque, wireframe or terrain). */
function cycleDisplay(tile, holo) {
  const current = DISPLAY_MODES.indexOf(holo.data.terrain.display);
  saveDriverChanges(tile.document, {terrain: {display: DISPLAY_MODES[(current + 1) % DISPLAY_MODES.length]}});
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
