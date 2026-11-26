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
  camera: {yaw: 0.6, pitch: 0.95, dist: 4.8},
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
    projector: true
  },
  terrain: {
    /** Greyscale image covering the same area as the tile's image; brighter is higher. */
    heightmap: "",
    relief: 0.4,
    resolution: 160,
    wire: 0.6,
    contours: 0.5
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
  text: {camera: {yaw: 0, pitch: Math.PI / 2}, look: {spin: 0, projector: false}}
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
