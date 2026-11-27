import {INKS, MAX_LABEL_LENGTH, formatArea} from "./data.mjs";

/** How long a freshly drawn area may take to arrive from the GM before its card gives up. */
const PENDING_MS = 3000;

/** @type {{element: HTMLElement, tile: Tile, holo: HoloRenderer, id: string, pendingUntil: number, shown: string}|null} */
let card = null;

/**
 * Open the card of one area next to its label: its name, ink and size, and a way to delete it.
 * @param {Tile} tile
 * @param {HoloRenderer} holo
 * @param {string} id
 * @param {{update: (changes: object) => void, remove: () => void}} actions
 */
export function openAreaCard(tile, holo, id, actions) {
  closeAreaCard();
  const localize = key => game.i18n.localize(`VIRAHOLO.Area.${key}`);
  const element = document.createElement("div");
  element.className = "vira-holo-card vira-holo-area-card";
  element.hidden = true;
  element.style.setProperty("--holo-color", holo.data.look.color);
  element.innerHTML = `
    <header><b>${localize("Title")}</b><button type="button" class="close" aria-label="${localize("Close")}">✕</button></header>
    <input type="text" class="label" maxlength="${MAX_LABEL_LENGTH}" placeholder="${localize("Label")}" aria-label="${localize("Label")}">
    <div class="inks">${INKS.map(color => `<button type="button" data-ink="${color}" style="--ink: ${color}"
      aria-label="${color}"></button>`).join("")}<input type="color" class="custom" aria-label="${localize("CustomInk")}"
      data-tooltip="${localize("CustomInk")}"></div>
    <div class="distance"></div>
    <div class="actions"><button type="button" class="delete">${localize("Delete")}</button></div>`;
  document.body.append(element);
  card = {element, tile, holo, id, pendingUntil: performance.now() + PENDING_MS, shown: ""};
  holo.selectedArea = id;

  element.querySelector(".close").addEventListener("click", closeAreaCard);
  const label = element.querySelector(".label");
  label.value = holo.annotation("areas", id)?.label ?? "";
  label.addEventListener("change", () => actions.update({label: label.value}));
  label.addEventListener("keydown", event => {
    if ( event.key === "Enter" ) label.blur();
    else if ( event.key === "Escape" ) closeAreaCard();
    event.stopPropagation(); // Keep Foundry's keybindings out while typing
  });
  for ( const button of element.querySelectorAll("[data-ink]") ) {
    button.addEventListener("click", () => actions.update({color: button.dataset.ink}));
  }
  const custom = element.querySelector(".custom");
  custom.value = holo.annotation("areas", id)?.color ?? INKS[0];
  custom.addEventListener("change", () => actions.update({color: custom.value}));
  element.querySelector(".delete").addEventListener("click", () => {
    actions.remove();
    closeAreaCard();
  });
  updateAreaCard();
}

export function closeAreaCard() {
  if ( !card ) return;
  if ( card.holo.selectedArea === card.id ) card.holo.selectedArea = null;
  card.element.remove();
  card = null;
}

/** Did this event happen on the card? */
export function isAreaCardEvent(event) {
  return !!card && card.element.contains(event.target);
}

/** Keep the card above its label, its ink marked and its size up to date. */
export function updateAreaCard() {
  if ( !card ) return;
  const {tile, holo, id, element} = card;
  if ( tile.destroyed ) return closeAreaCard();
  const area = holo.areas.find(a => a.id === id);
  if ( !area ) {
    // Not saved yet (just drawn) or deleted by someone else.
    if ( performance.now() > card.pendingUntil ) closeAreaCard();
    return;
  }
  card.pendingUntil = 0;
  const tip = holo.areaTip(id);
  if ( !tip || !tile.visible ) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  const {x, y} = canvas.clientCoordinatesFromCanvas(holo.toCanvasPoint(tip));
  const {offsetWidth: w, offsetHeight: h} = element;
  element.style.left = `${Math.clamp(x - (w / 2), 8, window.innerWidth - w - 8)}px`;
  element.style.top = `${Math.clamp(y - h - 10, 8, window.innerHeight - h - 8)}px`;

  const squareMetres = holo.areaSize(area);
  const shown = `${area.color}|${squareMetres}|${holo.data.scale.unit}`;
  if ( shown === card.shown ) return;
  card.shown = shown;
  for ( const button of element.querySelectorAll("[data-ink]") ) button.classList.toggle("on", button.dataset.ink === area.color);
  element.querySelector(".distance").textContent = (squareMetres === null) ? game.i18n.localize("VIRAHOLO.Area.NoScale")
    : formatArea(squareMetres, holo.data.scale.unit);
}
