export const MODULE_ID = "vira-holo";

/**
 * Default hologram state stored under `flags.vira-holo` on a Tile.
 * Camera angles are radians; pitch is the camera's elevation above the floor (PI/2 = straight down).
 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  /**
   * "image": the tile's image as a floating panel. "terrain": the image draped over a heightmap.
   * "text": sign text on a panel shaped like the tile.
   */
  mode: "image",
  /** The projected image. For an unlinked tile this is the tile's own image (texture.src), not a flag. */
  image: "",
  /** Whether users who may drive the hologram can grab, orbit and zoom it on the canvas. */
  interactive: true,
  /** IDs of non-GM users who may drive the hologram. */
  owners: [],
  /**
   * Orbit camera. x/z is the point on the floor it looks at, in footprint units (-1..1); spin is auto-rotation in
   * radians per second, added to yaw from the shared server clock.
   */
  camera: {yaw: 0.6, pitch: 0.95, dist: 4.8, x: 0, z: 0, spin: 0.08},
  look: {
    color: "#ff9f43",
    tint: 0.75,
    opacity: 0.9,
    solidity: 0.35,
    scanlines: 0.5,
    flicker: 0.3,
    lift: 0.12,
    /** Show the projector disc under the hologram. */
    projector: true,
    /** Density of the specks of light rising through the hologram (0 = none). */
    motes: 0.5,
    /** Show waypoint labels. */
    labels: true
  },
  terrain: {
    /** Greyscale image covering the same area as the tile's image; brighter is higher. */
    heightmap: "",
    relief: 0.4,
    resolution: 160,
    wire: 0.6,
    contours: 0.5,
    /** Display style (DISPLAY_MODES): see-through or opaque, wireframe or terrain. */
    display: "xray"
  },
  annotations: {
    /**
     * Waypoints: {id, u, v, label, glyph, color, size, locked}. u/v is the position on the image (0..1, top-left
     * origin); size is a tier from 1 (small) to 3 (large); locked pins can't be dragged.
     */
    markers: [],
    /**
     * Freehand ink: {id, color, width, points}. points is a flat [u, v, u, v, ...] list on the image (like
     * waypoints), so strokes stay on the surface as it turns and follow the terrain; width is a tier from 1 to 3.
     */
    strokes: [],
    /** Measurements: {id, points: [ua, va, ub, vb]}, two points on the image like waypoints. */
    measures: []
  },
  /**
   * Real-world size of the image: it covers `distance` units across its width or height ("axis"). A distance of 0
   * means no scale is set, and measurements can't show a length.
   */
  scale: {distance: 0, unit: "km", axis: "width"},
  text: {
    content: "",
    /** Empty uses the world's default font. */
    font: "",
    /** Font size in scene pixels, like Drawing text. Text that doesn't fit is shrunk. */
    size: 48,
    align: "center"
  }
});

/** Defaults that differ per mode: signs face the viewer, hold still and have no projector disc. */
const MODE_DEFAULTS = Object.freeze({
  text: {interactive: false, camera: {yaw: 0, pitch: Math.PI / 2, spin: 0}, look: {projector: false, motes: 0}}
});

/**
 * What a link can share, by section, and the top-level keys of the hologram data each section covers.
 * Never shared: enabled, interactive, owners and the tile's placement.
 */
export const LINK_SECTIONS = Object.freeze({
  content: ["mode", "image", "terrain", "text", "scale"],
  annotations: ["annotations"],
  view: ["camera"],
  look: ["look"]
});
export const DEFAULT_SHARE = Object.freeze({content: true, annotations: true, view: false, look: true});

/** @returns {string|undefined} The link section a top-level hologram key belongs to */
export function sectionOf(key) {
  return Object.keys(LINK_SECTIONS).find(section => LINK_SECTIONS[section].includes(key));
}

/**
 * The link a tile follows: its JournalEntry and what it shares. A link stores its shared state in the journal's
 * `flags.vira-holo.state`, in the same shape as the hologram data.
 * @param {TileDocument} doc
 * @returns {{journal: JournalEntry, share: Record<string, boolean>}|null}   Null if unlinked or the journal is gone
 */
export function getLink(doc) {
  const ref = doc.flags?.[MODULE_ID]?.link;
  if ( !ref?.uuid ) return null;
  const journal = fromUuidSync(ref.uuid, {strict: false});
  if ( !journal?.getFlag(MODULE_ID, "state") ) return null;
  return {journal, share: {...DEFAULT_SHARE, ...ref.share}};
}

/**
 * The effective hologram state of a Tile document: defaults, then the mode's defaults, then the tile's flags, with
 * every section shared through a link taken from the link instead.
 * @param {TileDocument} doc
 * @returns {object}
 */
export function getHoloData(doc) {
  const source = foundry.utils.deepClone(doc.flags?.[MODULE_ID] ?? {});
  source.image = doc.texture?.src ?? "";
  delete source.link;
  const link = getLink(doc);
  if ( link ) {
    const state = link.journal.getFlag(MODULE_ID, "state");
    for ( const [section, keys] of Object.entries(LINK_SECTIONS) ) {
      if ( !link.share[section] ) continue;
      for ( const key of keys ) {
        delete source[key];
        if ( state[key] !== undefined ) source[key] = foundry.utils.deepClone(state[key]);
      }
    }
  }
  const data = foundry.utils.deepClone(DEFAULTS);
  foundry.utils.mergeObject(data, MODE_DEFAULTS[source.mode ?? data.mode] ?? {});
  foundry.utils.mergeObject(data, source);
  data.link = link ? {uuid: link.journal.uuid, name: link.journal.name, share: link.share} : null;
  data.linkMissing = !link && !!doc.flags?.[MODULE_ID]?.link?.uuid;
  return data;
}

/**
 * An update that removes a key: v14 deprecates the "-=key" syntax in favour of ForcedDeletion.
 * @param {string} path   e.g. "flags.vira-holo.link"
 */
export function deletionUpdate(path) {
  const ForcedDeletion = foundry.data.operators?.ForcedDeletion;
  if ( ForcedDeletion ) return {[path]: new ForcedDeletion()};
  const parts = path.split(".");
  const key = parts.pop();
  return {[[...parts, `-=${key}`].join(".")]: null};
}

/**
 * Can this user drive (orbit, zoom, pan) the hologram on this tile?
 * @param {User} user
 * @param {TileDocument} doc
 */
export function canDrive(user, doc) {
  if ( !user ) return false;
  return user.isGM || !!doc.getFlag(MODULE_ID, "owners")?.includes(user.id);
}

/**
 * The camera a hologram in this mode starts with.
 * @param {string} mode
 * @returns {object}
 */
export function defaultCamera(mode) {
  return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULTS.camera), MODE_DEFAULTS[mode]?.camera ?? {});
}

/** Waypoint inks, as in the mockup: amber, ember, gold, alert, verify, arcane. */
export const INKS = Object.freeze(["#ffb020", "#ff7a1a", "#ffe066", "#ff4d5e", "#8dff57", "#5b8cff"]);
export const MARKER_GLYPHS = Object.freeze(["diamond", "triangle", "circle", "square"]);
export const MAX_MARKERS = 64;
export const MAX_LABEL_LENGTH = 32;
/** Pin size tiers: tier → scale of the largest pin. */
export const MARKER_SIZES = Object.freeze({1: 0.5, 2: 0.72, 3: 1});
/** Every edit rewrites the whole stroke list (like waypoints), so keep it bounded. */
export const MAX_STROKES = 100;
export const MAX_STROKE_POINTS = 400;
/** Stroke width tiers: tier → line width relative to a medium stroke. */
export const STROKE_WIDTHS = Object.freeze({1: 0.5, 2: 1, 3: 1.8});
export const MAX_MEASURES = 50;
/** Terrain display styles, in the order the ring cycles through them. */
export const DISPLAY_MODES = Object.freeze(["wireXray", "wire", "xray", "solid"]);
/** Ink of measurements, as in the mockup. */
export const MEASURE_INK = "#ffe066";

/** Length units for a map's scale, in metres, by measuring system. */
export const UNITS = Object.freeze({
  m: {metres: 1, system: "metric"},
  km: {metres: 1000, system: "metric"},
  ft: {metres: 0.3048, system: "imperial"},
  mi: {metres: 1609.344, system: "imperial"}
});

/**
 * A length for display, in the scale's measuring system: metres up to a kilometre, then kilometres; feet up to a
 * mile, then miles.
 * @param {number} metres
 * @param {string} unit   The scale's unit, which picks the system
 * @returns {string}
 */
export function formatDistance(metres, unit) {
  const imperial = UNITS[unit]?.system === "imperial";
  const [small, large] = imperial ? ["ft", "mi"] : ["m", "km"];
  const value = metres / UNITS[small].metres;
  const threshold = UNITS[large].metres / UNITS[small].metres;
  const label = key => game.i18n.localize(`VIRAHOLO.Units.${key}`);
  const round = v => v.toLocaleString(game.i18n.lang, {maximumFractionDigits: (v < 10) ? 1 : 0});
  if ( value < threshold ) return `${round(value)} ${label(small)}`;
  const big = metres / UNITS[large].metres;
  return `${big.toLocaleString(game.i18n.lang, {maximumFractionDigits: (big < 100) ? 2 : 0})} ${label(large)}`;
}

/**
 * The ink that stands out most against a hologram colour (largest hue difference), for new waypoints.
 * @param {string} color
 */
export function contrastingInk(color) {
  const hue = c => {
    const [r, g, b] = new PIXI.Color(c).toRgbArray();
    const max = Math.max(r, g, b);
    const range = max - Math.min(r, g, b);
    if ( !range ) return 0;
    const h = (max === r) ? ((g - b) / range) : (max === g) ? (((b - r) / range) + 2) : (((r - g) / range) + 4);
    return ((h * 60) + 360) % 360;
  };
  const base = hue(color);
  const distance = c => {
    const d = Math.abs(hue(c) - base);
    return Math.min(d, 360 - d);
  };
  return INKS.reduce((best, ink) => (distance(ink) > distance(best) ? ink : best));
}

/**
 * A waypoint with every field checked and coerced, for anything that arrives from a form or another client.
 * @param {object} marker
 * @returns {object|null}   Null when it has no usable position or ID
 */
export function sanitizeMarker(marker) {
  const {id, u, v, label, glyph, color, size, locked} = marker ?? {};
  if ( (typeof id !== "string") || !/^[a-zA-Z0-9]{16}$/.test(id) ) return null;
  if ( !Number.isFinite(u) || !Number.isFinite(v) ) return null;
  return {
    id,
    u: Math.clamp(u, 0, 1),
    v: Math.clamp(v, 0, 1),
    label: String(label ?? "").slice(0, MAX_LABEL_LENGTH),
    glyph: MARKER_GLYPHS.includes(glyph) ? glyph : MARKER_GLYPHS[0],
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : INKS[0],
    size: (size in MARKER_SIZES) ? Number(size) : 3,
    locked: locked === true
  };
}

/**
 * A stroke with every field checked and coerced, like sanitizeMarker. Points are rounded to 1/10000 of the image.
 * @param {object} stroke
 * @returns {object|null}   Null without an ID or at least two finite points
 */
export function sanitizeStroke(stroke) {
  const {id, color, width, points} = stroke ?? {};
  if ( (typeof id !== "string") || !/^[a-zA-Z0-9]{16}$/.test(id) || !Array.isArray(points) ) return null;
  const count = Math.min(Math.floor(points.length / 2), MAX_STROKE_POINTS);
  if ( (count < 2) || !points.slice(0, count * 2).every(Number.isFinite) ) return null;
  return {
    id,
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : INKS[0],
    width: (width in STROKE_WIDTHS) ? Number(width) : 2,
    points: points.slice(0, count * 2).map(p => Math.round(Math.clamp(p, 0, 1) * 10000) / 10000)
  };
}

/**
 * A measurement with its two points checked and rounded like a stroke's.
 * @param {object} measure
 * @returns {object|null}
 */
export function sanitizeMeasure(measure) {
  const {id, points} = measure ?? {};
  if ( (typeof id !== "string") || !/^[a-zA-Z0-9]{16}$/.test(id) || !Array.isArray(points) ) return null;
  if ( (points.length !== 4) || !points.every(Number.isFinite) ) return null;
  return {id, points: points.map(p => Math.round(Math.clamp(p, 0, 1) * 10000) / 10000)};
}

/**
 * A scale with every field checked, for the calibration that arrives from a measurement's card.
 * @param {object} scale
 * @returns {object|null}
 */
export function sanitizeScale(scale) {
  const {distance, unit, axis} = scale ?? {};
  if ( !Number.isFinite(distance) || (distance < 0) || !(unit in UNITS) ) return null;
  return {distance, unit, axis: (axis === "height") ? "height" : "width"};
}
