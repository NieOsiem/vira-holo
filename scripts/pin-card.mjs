import {INKS, MARKER_GLYPHS, MARKER_SIZES, MAX_LABEL_LENGTH} from "./data.mjs";

const GLYPH_CHARACTERS = {diamond: "◆", triangle: "▲", circle: "●", square: "■"};
/** How long a freshly placed waypoint may take to arrive from the GM before its card gives up. */
const PENDING_MS = 3000;

/**
 * @typedef {object} CardActions
 * @property {(changes: object) => void} update
 * @property {() => void} [remove]   Waypoints only
 * @property {() => void} [enter]    Portals only: travel into the map
 * @property {() => void} focus
 */

/** @type {{element: HTMLElement, tile: Tile, holo: HoloRenderer, id: string, actions: CardActions,
 *          pendingUntil: number, shown: string}|null} */
let card = null;

/**
 * Open the editor for one waypoint next to its pin, or the card of a portal: a map placed here, which it enters.
 * A portal has no glyph choice or delete; only GMs rename its map or restyle it (it's stored with the map).
 * @param {Tile} tile
 * @param {HoloRenderer} holo
 * @param {string} id
 * @param {CardActions} actions
 * @param {{portal?: boolean}} [options]
 */
export function openCard(tile, holo, id, actions, {portal=false}={}) {
  closeCard();
  const localize = key => game.i18n.localize(`VIRAHOLO.Card.${key}`);
  const editable = !portal || game.user.isGM;
  const element = document.createElement("div");
  element.className = "vira-holo-card";
  element.classList.toggle("portal", portal);
  element.classList.toggle("readonly", !editable);
  element.hidden = true;
  element.style.setProperty("--holo-color", holo.data.look.color);
  element.innerHTML = `
    <header><b>${localize(portal ? "PortalTitle" : "Title")}</b><button type="button" class="close" aria-label="${localize("Close")}">✕</button></header>
    <input type="text" class="label" maxlength="${MAX_LABEL_LENGTH}" placeholder="${localize("Label")}"
      aria-label="${localize("Label")}" ${editable ? "" : "readonly"}>
    <div class="glyphs">${MARKER_GLYPHS.map(glyph => `<button type="button" data-glyph="${glyph}"
      aria-label="${localize(`Glyph.${glyph}`)}" data-tooltip="${localize(`Glyph.${glyph}`)}">${GLYPH_CHARACTERS[glyph]}</button>`).join("")}</div>
    <div class="sizes">${Object.keys(MARKER_SIZES).map(size => `<button type="button" data-size="${size}"
      aria-label="${localize(`Size.${size}`)}" data-tooltip="${localize(`Size.${size}`)}">${localize(`SizeShort.${size}`)}</button>`).join("")}</div>
    <div class="inks">${INKS.map(color => `<button type="button" data-ink="${color}" style="--ink: ${color}"
      aria-label="${color}"></button>`).join("")}<input type="color" class="custom" aria-label="${localize("CustomInk")}"
      data-tooltip="${localize("CustomInk")}"></div>
    <div class="actions">
      <button type="button" class="lock" aria-label="${localize("Lock")}" data-tooltip="${localize("Lock")}">
        <i class="fa-solid fa-lock-open" inert></i></button>
      <button type="button" class="focus">${localize("Focus")}</button>
      ${portal ? `<button type="button" class="enter">${localize("Enter")}</button>`
    : `<button type="button" class="delete">${localize("Delete")}</button>`}
    </div>
    <p class="hint"></p>`;
  document.body.append(element);
  card = {element, tile, holo, id, actions, portal, pendingUntil: performance.now() + PENDING_MS, shown: ""};
  holo.selectedMarker = id;

  element.querySelector(".close").addEventListener("click", closeCard);
  const label = element.querySelector(".label");
  label.addEventListener("change", () => actions.update({label: label.value}));
  label.addEventListener("keydown", event => {
    if ( event.key === "Enter" ) label.blur();
    else if ( event.key === "Escape" ) closeCard();
    event.stopPropagation(); // Keep Foundry's keybindings out while typing
  });
  for ( const button of element.querySelectorAll("[data-glyph]") ) {
    button.addEventListener("click", () => actions.update({glyph: button.dataset.glyph}));
  }
  for ( const button of element.querySelectorAll("[data-ink]") ) {
    button.addEventListener("click", () => actions.update({color: button.dataset.ink}));
  }
  for ( const button of element.querySelectorAll("[data-size]") ) {
    button.addEventListener("click", () => actions.update({size: Number(button.dataset.size)}));
  }
  const lock = element.querySelector(".lock");
  lock.addEventListener("click", () => actions.update({locked: !lock.classList.contains("on")}));
  const custom = element.querySelector(".custom");
  custom.addEventListener("change", () => actions.update({color: custom.value}));
  element.querySelector(".focus").addEventListener("click", () => actions.focus());
  element.querySelector(".delete")?.addEventListener("click", () => {
    actions.remove();
    closeCard();
  });
  element.querySelector(".enter")?.addEventListener("click", () => {
    closeCard();
    actions.enter();
  });
  updateCard();
}

export function closeCard() {
  if ( !card ) return;
  if ( card.holo.selectedMarker === card.id ) card.holo.selectedMarker = null;
  card.element.remove();
  card = null;
}

/** Did this event happen on the card? */
export function isCardEvent(event) {
  return !!card && card.element.contains(event.target);
}

/** Keep the card next to its pin (which moves as the hologram turns) and in step with edits from others. */
export function updateCard() {
  if ( !card ) return;
  const {tile, holo, id, element} = card;
  if ( tile.destroyed ) return closeCard();
  const marker = holo.markers.find(m => m.id === id);
  if ( !marker ) {
    // Not saved yet (just placed) or deleted by someone else.
    if ( performance.now() > card.pendingUntil ) closeCard();
    return;
  }
  card.pendingUntil = 0;
  const tip = holo.markerTip(id);
  if ( !tip || !tile.visible ) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  const {x, y} = canvas.clientCoordinatesFromCanvas(holo.toCanvasPoint(tip));
  const {offsetWidth: w, offsetHeight: h} = element;
  element.style.left = `${Math.clamp(x + 18, 8, window.innerWidth - w - 8)}px`;
  element.style.top = `${Math.clamp(y - 24, 8, window.innerHeight - h - 8)}px`;

  const shown = JSON.stringify(marker);
  if ( shown === card.shown ) return;
  card.shown = shown;
  const label = element.querySelector(".label");
  if ( document.activeElement !== label ) label.value = marker.label;
  for ( const button of element.querySelectorAll("[data-glyph]") ) {
    button.classList.toggle("on", button.dataset.glyph === marker.glyph);
  }
  const hint = card.portal ? (game.user.isGM ? "PortalHint" : "PortalHintPlayer") : "Hint";
  element.querySelector(".hint").textContent = game.i18n.localize(`VIRAHOLO.Card.${marker.locked ? "HintLocked" : hint}`);
  for ( const button of element.querySelectorAll("[data-ink]") ) {
    button.classList.toggle("on", button.dataset.ink.toLowerCase() === marker.color.toLowerCase());
  }
  for ( const button of element.querySelectorAll("[data-size]") ) {
    button.classList.toggle("on", Number(button.dataset.size) === (marker.size ?? 3));
  }
  const lock = element.querySelector(".lock");
  lock.classList.toggle("on", !!marker.locked);
  lock.setAttribute("aria-pressed", String(!!marker.locked));
  lock.querySelector("i").className = `fa-solid ${marker.locked ? "fa-lock" : "fa-lock-open"}`;
  element.querySelector(".custom").value = marker.color;
}
