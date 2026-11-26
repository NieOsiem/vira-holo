import {getHoloData} from "./data.mjs";

/** Stroke glyphs in the style of the original mockup. */
const GLYPHS = {
  recenter: '<circle cx="12" cy="12" r="6.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>'
    + '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  spin: '<path d="M3.5 12a8.5 8.5 0 0 1 14.4-6.1L21 8"/><path d="M21 3.2V8h-4.8"/>'
    + '<path d="M20.5 12a8.5 8.5 0 0 1-14.4 6.1L3 16"/><path d="M3 20.8V16h4.8"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/>'
    + '<circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'
};
/** Angle between neighbouring glyphs along the projection's edge, in radians. */
const ARC_STEP = 0.24;
/** Glyphs sit on this fraction of the projection ellipse. */
const ARC_RADIUS = 0.8;

/** @type {{tile: Tile, element: HTMLElement, buttons: HTMLButtonElement[]}|null} */
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
  const names = ["recenter", "spin", ...(game.user.isGM ? ["settings"] : [])];
  const buttons = names.map((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.glyph = name;
    button.dataset.tooltip = `VIRAHOLO.Ring.${name}`;
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
  ring = {tile, element, buttons};
  refreshRing();
}

export function hideRing() {
  ring?.element.remove();
  ring = null;
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

  const {look} = getHoloData(tile.document);
  const {width, height, rotation} = tile.document;
  const {x: cx, y: cy} = tile.center;
  const size = Math.clamp(Math.min(width, height) * 0.085, 28, 110);
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
    if ( button.dataset.glyph === "spin" ) {
      button.classList.toggle("on", look.spin !== 0);
      button.setAttribute("aria-pressed", String(look.spin !== 0));
    }
  });
}
