import {UNITS, formatDistance} from "./data.mjs";

/**
 * @typedef {object} MeasureCardActions
 * @property {() => void} remove
 * @property {(distance: number, unit: string) => void} [calibrate]   Only for GMs: set the scale from this line
 */

/** @type {{element: HTMLElement, tile: Tile, holo: HoloRenderer, id: string, pendingUntil: number,
 *          shown: string}|null} */
let card = null;
/** How long a freshly made measurement may take to arrive from the GM before its card gives up. */
const PENDING_MS = 3000;

/**
 * Open the card of one measurement next to its label: its length, a way to delete it and, for GMs, to set the
 * hologram's scale by saying how long this line really is.
 * @param {Tile} tile
 * @param {HoloRenderer} holo
 * @param {string} id
 * @param {MeasureCardActions} actions
 */
export function openMeasureCard(tile, holo, id, actions) {
  closeMeasureCard();
  const localize = key => game.i18n.localize(`VIRAHOLO.Measure.${key}`);
  const unit = holo.data.scale.unit;
  const units = Object.keys(UNITS).map(key => `<option value="${key}" ${key === unit ? "selected" : ""}>`
    + `${game.i18n.localize(`VIRAHOLO.Units.${key}`)}</option>`).join("");
  const element = document.createElement("div");
  element.className = "vira-holo-card vira-holo-measure-card";
  element.hidden = true;
  element.style.setProperty("--holo-color", holo.data.look.color);
  element.innerHTML = `
    <header><b>${localize("Title")}</b><button type="button" class="close" aria-label="${localize("Close")}">✕</button></header>
    <div class="distance"></div>
    ${actions.calibrate ? `<form class="calibrate">
      <label>${localize("ThisIs")}</label>
      <input type="number" class="value" min="0" step="any" required aria-label="${localize("Length")}">
      <select class="unit" aria-label="${localize("Unit")}">${units}</select>
      <button type="submit" class="set" data-tooltip="${localize("SetScaleHint")}">${localize("SetScale")}</button>
    </form>` : ""}
    <div class="actions"><button type="button" class="delete">${localize("Delete")}</button></div>
    <p class="hint"></p>`;
  document.body.append(element);
  card = {element, tile, holo, id, pendingUntil: performance.now() + PENDING_MS, shown: ""};
  holo.selectedMeasure = id;

  element.querySelector(".close").addEventListener("click", closeMeasureCard);
  element.querySelector(".delete").addEventListener("click", () => {
    actions.remove();
    closeMeasureCard();
  });
  const form = element.querySelector(".calibrate");
  form?.addEventListener("submit", event => {
    event.preventDefault();
    const value = Number(form.querySelector(".value").value);
    if ( value > 0 ) actions.calibrate(value, form.querySelector(".unit").value);
  });
  // Keep Foundry's keybindings out while typing.
  form?.addEventListener("keydown", event => {
    if ( event.key === "Escape" ) closeMeasureCard();
    else if ( event.key === "Enter" ) {
      event.preventDefault();
      form.requestSubmit();
    }
    event.stopPropagation();
  });
  updateMeasureCard();
}

export function closeMeasureCard() {
  if ( !card ) return;
  if ( card.holo.selectedMeasure === card.id ) card.holo.selectedMeasure = null;
  card.element.remove();
  card = null;
}

/** Did this event happen on the card? */
export function isMeasureCardEvent(event) {
  return !!card && card.element.contains(event.target);
}

/** Keep the card above its label and its length up to date (the scale may change while it is open). */
export function updateMeasureCard() {
  if ( !card ) return;
  const {tile, holo, id, element} = card;
  if ( tile.destroyed ) return closeMeasureCard();
  const measure = holo.data.annotations.measures.find(m => m.id === id);
  if ( !measure ) {
    // Not saved yet (just made) or deleted by someone else.
    if ( performance.now() > card.pendingUntil ) closeMeasureCard();
    return;
  }
  card.pendingUntil = 0;
  const tip = holo.measureTip(id);
  if ( !tip || !tile.visible ) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  const {x, y} = canvas.clientCoordinatesFromCanvas(holo.toCanvasPoint(tip));
  const {offsetWidth: w, offsetHeight: h} = element;
  element.style.left = `${Math.clamp(x - (w / 2), 8, window.innerWidth - w - 8)}px`;
  element.style.top = `${Math.clamp(y - h - 10, 8, window.innerHeight - h - 8)}px`;

  const metres = holo.measureLength(measure.points);
  const shown = `${metres}|${holo.data.scale.unit}`;
  if ( shown === card.shown ) return;
  card.shown = shown;
  const localize = key => game.i18n.localize(`VIRAHOLO.Measure.${key}`);
  element.querySelector(".distance").textContent = (metres === null) ? localize("NoScale")
    : formatDistance(metres, holo.data.scale.unit);
  const calibrating = !!element.querySelector(".calibrate");
  element.querySelector(".hint").textContent = localize(calibrating ? "HintGM" : ((metres === null) ? "HintNoScale" : "Hint"));
}
