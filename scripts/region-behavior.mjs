import {MODULE_ID} from "./data.mjs";
import {api} from "./api.mjs";

/** The region behaviour's type, declared in module.json's documentTypes. */
export const BEHAVIOR_TYPE = `${MODULE_ID}.hologram`;
const ACTIONS = ["on", "off", "toggle", "next", "previous", "page"];

/**
 * A Scene Region behaviour that switches holograms on or off or turns signs' pages when tokens enter, leave or
 * act in the region. It runs on the active GM's client only (region events reach every client).
 */
export function registerRegionBehavior() {
  const Base = foundry.data.regionBehaviors?.RegionBehaviorType;
  if ( !Base ) return;
  const {fields} = foundry.data;

  class HologramRegionBehavior extends Base {
    static LOCALIZATION_PREFIXES = ["VIRAHOLO.Behavior", "BEHAVIOR.TYPES.base"];

    static defineSchema() {
      const E = CONST.REGION_EVENTS;
      // Names differ between versions (v12's TOKEN_MOVE became TOKEN_MOVE_WITHIN): keep the ones this one has.
      const events = [E.TOKEN_ENTER, E.TOKEN_EXIT, E.TOKEN_MOVE_IN, E.TOKEN_MOVE_OUT, E.TOKEN_TURN_START, E.TOKEN_TURN_END,
        E.TOKEN_ROUND_START, E.TOKEN_ROUND_END].filter(Boolean);
      return {
        events: this._createEventsField({events, initial: [E.TOKEN_ENTER]}),
        // UUIDs rather than choices of tiles: choices would fail validation on clients viewing another scene.
        tiles: new fields.SetField(new fields.DocumentUUIDField({type: "Tile"})),
        action: new fields.StringField({required: true, initial: "on",
          choices: () => Object.fromEntries(ACTIONS.map(a => [a, game.i18n.localize(`VIRAHOLO.Behavior.Action.${a}`)]))}),
        page: new fields.NumberField({required: true, integer: true, min: 1, initial: 1})
      };
    }

    /** @override */
    async _handleRegionEvent(event) {
      if ( !game.users.activeGM?.isSelf ) return;
      for ( const uuid of this.tiles ) {
        const doc = fromUuidSync(uuid, {strict: false});
        if ( !doc?.getFlag(MODULE_ID, "enabled") ) continue;
        try {
          switch ( this.action ) {
            case "on": await api.power(doc, true); break;
            case "off": await api.power(doc, false); break;
            case "toggle": await api.power(doc); break;
            case "page": await api.page(doc, this.page); break;
            default: await api.page(doc, this.action);
          }
        } catch(err) {
          console.warn(`Vira Holo | Region behaviour on ${uuid}:`, err.message);
        }
      }
    }
  }

  CONFIG.RegionBehavior.dataModels[BEHAVIOR_TYPE] = HologramRegionBehavior;
  CONFIG.RegionBehavior.typeIcons[BEHAVIOR_TYPE] = "fa-solid fa-cube";
  Hooks.on("renderRegionBehaviorConfig", addHologramPicker);
}

/**
 * Tiles can't be dragged off the canvas onto the behaviour's tile list, so offer the region's scene's holograms
 * in a dropdown that adds one to the list.
 */
function addHologramPicker(app, html) {
  const behavior = app.document;
  if ( behavior?.type !== BEHAVIOR_TYPE ) return;
  const root = (html instanceof HTMLElement) ? html : html[0];
  const tags = root?.querySelector('document-tags[name="system.tiles"]');
  if ( !tags || root.querySelector(".vira-holo-hologram-picker") ) return;
  const scene = behavior.parent?.parent;
  const holograms = scene?.tiles.filter(t => t.getFlag(MODULE_ID, "enabled")) ?? [];
  const select = document.createElement("select");
  select.className = "vira-holo-hologram-picker";
  const label = tile => {
    const data = api.data(tile);
    const text = (data.mode === "text") ? (data.text.content ?? "").split("\n")[0].trim() : "";
    return `${text || game.i18n.localize(`VIRAHOLO.Mode.${data.mode}`)} (${tile.id})`;
  };
  select.innerHTML = `<option value="">${game.i18n.localize("VIRAHOLO.Behavior.AddHologram")}</option>`
    + holograms.map(tile => `<option value="${tile.uuid}">${foundry.utils.escapeHTML?.(label(tile)) ?? label(tile)}</option>`).join("");
  select.addEventListener("change", () => {
    const uuid = select.value;
    select.value = "";
    const current = Array.from(tags.value ?? []);
    if ( uuid && !current.includes(uuid) ) tags.value = [...current, uuid];
  });
  tags.after(select);
}
