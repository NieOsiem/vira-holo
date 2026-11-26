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
  /** Whether users who may drive the hologram can grab, orbit and zoom it on the canvas. */
  interactive: true,
  /** IDs of non-GM users who may drive the hologram. */
  owners: [],
  /** Orbit camera. x/z is the point on the floor it looks at, in footprint units (-1..1). */
  camera: {yaw: 0.6, pitch: 0.95, dist: 4.8, x: 0, z: 0},
  look: {
    color: "#ff9f43",
    tint: 0.75,
    opacity: 0.9,
    solidity: 0.35,
    scanlines: 0.5,
    flicker: 0.3,
    spin: 0.08,
    lift: 0.12,
    /** Show the projector disc under the hologram. */
    projector: true,
    /** Show waypoint labels. */
    labels: true
  },
  terrain: {
    /** Greyscale image covering the same area as the tile's image; brighter is higher. */
    heightmap: "",
    relief: 0.4,
    resolution: 160,
    wire: 0.6,
    contours: 0.5
  },
  annotations: {
    /** Waypoints: {id, u, v, label, glyph, color}; u/v is the position on the image (0..1, top-left origin). */
    markers: []
  },
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
  text: {interactive: false, camera: {yaw: 0, pitch: Math.PI / 2}, look: {spin: 0, projector: false}}
});

/**
 * The effective hologram state of a Tile document: defaults overlaid with its flags.
 * @param {TileDocument} doc
 * @returns {object}
 */
export function getHoloData(doc) {
  const flags = doc.flags?.[MODULE_ID] ?? {};
  const data = foundry.utils.deepClone(DEFAULTS);
  foundry.utils.mergeObject(data, MODE_DEFAULTS[flags.mode ?? data.mode] ?? {});
  return foundry.utils.mergeObject(data, flags);
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
  const {id, u, v, label, glyph, color} = marker ?? {};
  if ( (typeof id !== "string") || !/^[a-zA-Z0-9]{16}$/.test(id) ) return null;
  if ( !Number.isFinite(u) || !Number.isFinite(v) ) return null;
  return {
    id,
    u: Math.clamp(u, 0, 1),
    v: Math.clamp(v, 0, 1),
    label: String(label ?? "").slice(0, MAX_LABEL_LENGTH),
    glyph: MARKER_GLYPHS.includes(glyph) ? glyph : MARKER_GLYPHS[0],
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : INKS[0]
  };
}
