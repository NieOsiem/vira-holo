/** What pins', measurements' and areas' labels have in common: their font, its spacing, and their outline. */

/** The font labels use unless the look names another. */
const DEFAULT_FONT = "monospace";
/** Label size (the look's) at or under which label outlines are hairline-thin. */
const HAIRLINE_SIZE = 0.8;

/** @type {Map<string, boolean>} Fonts asked for, and whether they're ready to draw with. */
const fonts = new Map();
let measureContext = null;

/**
 * How labels are drawn, from the hologram's look: {size, font, spacing, hairline, ready}. `ready` turns true once
 * the font has loaded, so labels drawn before then (in a fallback font) are drawn again.
 * @param {object} look
 * @param {number} size   The label size, already checked
 */
export function labelStyle(look, size) {
  const font = (typeof look.labelFont === "string") && look.labelFont.trim() ? look.labelFont.trim() : DEFAULT_FONT;
  if ( !fonts.has(font) ) {
    fonts.set(font, font === DEFAULT_FONT);
    if ( font !== DEFAULT_FONT ) {
      document.fonts.load(`bold 32px "${font}"`)
        .catch(err => console.warn(`Vira Holo | Could not load font "${font}"`, err))
        .finally(() => fonts.set(font, true));
    }
  }
  const spacing = Number.isFinite(Number(look.labelSpacing)) ? Number(look.labelSpacing) : 0;
  return {size, font, spacing, hairline: size <= HAIRLINE_SIZE, ready: fonts.get(font)};
}

/**
 * Give a label's Text its font, size and letter spacing (in ems of that size), and set its text.
 * @param {PIXI.Text} text
 * @param {string} content
 * @param {number} fontSize
 * @param {{font: string, spacing: number}} style
 */
export function setLabelText(text, content, fontSize, {font, spacing}) {
  text.style.fontFamily = font;
  text.style.fontSize = fontSize;
  text.style.letterSpacing = spacing * fontSize;
  text.text = content;
}

/**
 * Where a label's text is drawn inside a box of height `height`, so its letters (not the font's full line, which has
 * room below for descenders capitals never use) sit in the middle: the Text's y.
 * @param {PIXI.Text} text
 * @param {number} height
 */
export function centredTextY(text, height) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  measureContext.font = text.style.toFontString();
  const metrics = measureContext.measureText(text.text);
  // PIXI puts the baseline at the font's ascent below the Text's top.
  const {ascent} = PIXI.TextMetrics.measureFont(measureContext.font);
  const top = ascent - metrics.actualBoundingBoxAscent;
  const bottom = ascent + metrics.actualBoundingBoxDescent;
  if ( !(bottom > top) ) return (height - text.height) / 2;
  return ((height - (bottom - top)) / 2) - top;
}

/**
 * A label outline's width in render-texture pixels: a share of the font size, never under a device pixel; for small
 * labels a hairline (twice that when selected).
 * @param {number} fontSize
 * @param {number} share
 * @param {{hairline: boolean}} style
 * @param {number} resolution   Device pixels per render-texture pixel
 * @param {boolean} [selected]
 */
export function outlineWidth(fontSize, share, {hairline}, resolution, selected=false) {
  const pixel = 1 / resolution;
  if ( hairline ) return pixel * (selected ? 2 : 1);
  return Math.max(pixel, fontSize * share);
}
