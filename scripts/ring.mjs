import {DISPLAY_MODES, INKS, STROKE_WIDTHS, getHoloData} from "./data.mjs";

/** Stroke glyphs in the style of the original mockup. */
const GLYPHS = {
  up: '<path d="M12 16V3.5M6.5 9 12 3.5 17.5 9"/><path d="M3.5 14v5.5h17V14"/>',  recenter: '<circle cx="12" cy="12" r="6.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>'
    + '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  spin: '<path d="M3.5 12a8.5 8.5 0 0 1 14.4-6.1L21 8"/><path d="M21 3.2V8h-4.8"/>'
    + '<path d="M20.5 12a8.5 8.5 0 0 1-14.4 6.1L3 16"/><path d="M3 20.8V16h4.8"/>',
  waypoint: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.8"/>',
  draw: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  erase: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/>',
  measure: '<path d="M2 12h20M6 8v8M12 6v12M18 8v8"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/>'
    + '<circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'
};
/** The terrain display glyph shows the current style: a two-peak mountain, wireframe or filled, see-through or not. */
const MOUNTAIN = "M2 19 9 6.5l4 6 3-4.5 6 11z";
const DISPLAY_GLYPHS = {
  wireXray: `<path d="${MOUNTAIN}"/><path d="M5.5 13h12M9 6.5 11 19M16 8l-2 11" stroke-dasharray="1.6 1.6"/>`,
  wire: `<path d="${MOUNTAIN}"/><path d="M5.5 13h12M9 6.5 11 19M16 8l-2 11"/>`,
  xray: `<path d="${MOUNTAIN}" fill="currentColor" fill-opacity="0.3"/><path d="M5.5 13h12M9 6.5 11 19"/>`,
  solid: `<path d="${MOUNTAIN}" fill="currentColor"/>`
};
GLYPHS.display = DISPLAY_GLYPHS.xray;

/** Angle between neighbouring glyphs along the projection's edge, in radians. */
const ARC_STEP = 0.13;
/** Glyphs sit on this fraction of the projection ellipse. */
const ARC_RADIUS = 0.8;

/**
 * @typedef {object} StripOptions
 * @property {string} glyph                    The tool glyph the strip sits under
 * @property {string} ink                      Selected ink
 * @property {number} [width]                  Selected stroke width tier; omit to hide the widths
 * @property {(ink: string) => void} onInk
 * @property {(width: number) => void} [onWidth]
 */

/** @type {{tile: Tile, actions: object, terrain: boolean, up: boolean, element: HTMLElement, buttons: HTMLButtonElement[],
 *          strip: HTMLElement|null, stripGlyph: string|null, display: string|null}|null} */
let ring = null;

/**
 * Show the tool ring around a hologram. It lives in Foundry's #hud layer, which is positioned and scaled with the
 * canvas, so glyphs are placed once in canvas coordinates and move with the map.
 * @param {Tile} tile
 * @param {Record<string, Function>} actions   Handlers keyed by glyph name
 */
export function showRing(tile, actions) {
  if ( ring?.tile === tile ) return refreshRing();
  hideRing();
  const element = document.createElement("div");
  element.className = "vira-holo-ring";
  const {mode, map} = getHoloData(tile.document);
  const terrain = mode === "terrain";
  const up = !!map.parent;
  const names = [...(up ? ["up"] : []), "recenter", "spin", ...(terrain ? ["display"] : []), "waypoint", "draw", "erase", "measure", "undo",
    "redo", ...(game.user.isGM ? ["settings"] : [])];
  const buttons = names.map((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.glyph = name;
    button.dataset.tooltip = `VIRAHOLO.Ring.${name}`;
    button.dataset.tooltipDirection = "UP"; // The ink strip sits below
    button.setAttribute("aria-label", game.i18n.localize(`VIRAHOLO.Ring.${name}`));
    button.style.setProperty("--index", index);
    button.innerHTML = `<span class="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" `
      + `stroke-width="2.1">${GLYPHS[name]}</svg></span>`;
    button.addEventListener("click", event => {
      event.stopPropagation();
      actions[name]?.();
    });
    element.append(button);
    return button;
  });
  ring = {tile, actions, terrain, up, element, buttons, strip: null, stripGlyph: null, display: null};
  refreshRing();
}

export function hideRing() {
  ring?.element.remove();
  ring = null;
}

/**
 * Light up (or dim) a glyph that toggles a tool.
 * @param {string} name
 * @param {boolean} on
 * @param {number} [tier=1]   Tools with two modes show one or two dots under the glyph
 */
export function setGlyphOn(name, on, tier=1) {
  const button = ring?.element.querySelector(`[data-glyph="${name}"]`);
  button?.classList.toggle("on", on);
  button?.classList.toggle("tier-2", on && (tier === 2));
  button?.setAttribute("aria-pressed", String(on));
}

/**
 * Show the ink picker under a tool glyph (and stroke widths, for the pen), or hide it.
 * @param {StripOptions|null} options
 */
export function setStrip(options) {
  if ( !ring ) return;
  ring.strip?.remove();
  ring.strip = null;
  ring.stripGlyph = options?.glyph ?? null;
  if ( !options ) return;
  const {ink, width, onInk, onWidth} = options;
  const localize = key => game.i18n.localize(`VIRAHOLO.Ring.${key}`);
  const strip = document.createElement("div");
  strip.className = "vira-holo-strip";
  strip.innerHTML = INKS.map(color => `<button type="button" data-ink="${color}" style="--ink: ${color}"
    aria-label="${localize("ink")} ${color}"></button>`).join("")
    + `<input type="color" class="custom" value="${ink}" aria-label="${localize("customInk")}"
      data-tooltip="${localize("customInk")}">`
    + ((width === undefined) ? "" : `<span class="separator"></span>${Object.keys(STROKE_WIDTHS).map(tier => `<button
      type="button" data-width="${tier}" style="--tier: ${tier}" aria-label="${localize(`width.${tier}`)}"
      data-tooltip="${localize(`width.${tier}`)}"><span></span></button>`).join("")}`);
  const select = (attribute, value) => {
    for ( const button of strip.querySelectorAll(`[${attribute}]`) ) {
      const on = button.getAttribute(attribute).toLowerCase() === String(value).toLowerCase();
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
  };
  for ( const button of strip.querySelectorAll("[data-ink]") ) {
    button.addEventListener("click", () => {
      select("data-ink", button.dataset.ink);
      onInk(button.dataset.ink);
    });
  }
  const custom = strip.querySelector(".custom");
  custom.addEventListener("input", () => {
    select("data-ink", custom.value);
    onInk(custom.value);
  });
  for ( const button of strip.querySelectorAll("[data-width]") ) {
    button.addEventListener("click", () => {
      select("data-width", button.dataset.width);
      onWidth?.(Number(button.dataset.width));
    });
  }
  select("data-ink", ink);
  if ( width !== undefined ) select("data-width", width);
  ring.strip = strip;
  ring.element.append(strip);
  refreshRing();
}

/**
 * Enable or dim a glyph whose action may have nothing to do (undo, redo).
 * @param {string} name
 * @param {boolean} enabled
 */
export function setGlyphEnabled(name, enabled) {
  const button = ring?.element.querySelector(`[data-glyph="${name}"]`);
  if ( button ) button.disabled = !enabled;
}

/** Did this event happen on the ring? */
export function isRingEvent(event) {
  return !!ring && ring.element.contains(event.target);
}

/** Re-place the ring after the tile moved, resized or changed its hologram settings. */
export function refreshRing(tile) {
  if ( !ring || (tile && (tile !== ring.tile)) ) return;
  const {element, buttons} = ring;
  tile = ring.tile;
  const hud = document.getElementById("hud");
  if ( tile.destroyed || !tile.visible || !hud ) return hideRing();
  if ( !element.isConnected ) hud.append(element);

  const {look, camera, mode, map, terrain: {display}} = getHoloData(tile.document);
  // The display glyph is only there for terrain, and "up" only below another map: rebuild the ring on a change.
  if ( ((mode === "terrain") !== ring.terrain) || (!!map.parent !== ring.up) ) {
    const {actions} = ring;
    hideRing();
    return showRing(tile, actions);
  }
  const displayButton = element.querySelector('[data-glyph="display"]');
  if ( displayButton && (ring.display !== display) ) {
    ring.display = display;
    displayButton.querySelector("svg").innerHTML = DISPLAY_GLYPHS[display] ?? DISPLAY_GLYPHS.xray;
    const label = `${game.i18n.localize("VIRAHOLO.Ring.display")}: ${game.i18n.localize(`VIRAHOLO.Display.${display}`)}`;
    displayButton.dataset.tooltip = label;
    displayButton.setAttribute("aria-label", label);
  }
  const {width, height, rotation} = tile.document;
  const {x: cx, y: cy} = tile.center;
  const size = Math.clamp(Math.min(width, height) * 0.042, 14, 54);
  const turn = Math.toRadians(rotation);
  element.style.setProperty("--holo-color", look.color);
  element.style.setProperty("--glyph-size", `${size}px`);
  buttons.forEach((button, index) => {
    // Left to right along the bottom of the ellipse (canvas y points down, so PI/2 is the bottom).
    const angle = (Math.PI / 2) - ((index - ((buttons.length - 1) / 2)) * ARC_STEP);
    const x = Math.cos(angle) * (width / 2) * ARC_RADIUS;
    const y = Math.sin(angle) * (height / 2) * ARC_RADIUS;
    button.style.left = `${cx + (x * Math.cos(turn)) - (y * Math.sin(turn)) - (size / 2)}px`;
    button.style.top = `${cy + (x * Math.sin(turn)) + (y * Math.cos(turn)) - (size / 2)}px`;
    if ( button.dataset.glyph === ring.stripGlyph ) {
      // Centred under its glyph; the strip's own size follows --glyph-size.
      ring.strip.style.left = `${parseFloat(button.style.left) + (size / 2)}px`;
      ring.strip.style.top = `${parseFloat(button.style.top) + (size * 1.05)}px`;
    }
    if ( button.dataset.glyph === "spin" ) {
      button.classList.toggle("on", camera.spin !== 0);
      button.setAttribute("aria-pressed", String(camera.spin !== 0));
    }
  });
}
