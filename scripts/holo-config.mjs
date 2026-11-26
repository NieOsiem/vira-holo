import {MODULE_ID, defaultCamera, getHoloData} from "./data.mjs";

const {HandlebarsApplicationMixin, DocumentSheetV2} = foundry.applications.api;

/** [key, min, max, step] for each slider, grouped by the flag section they edit. */
const SLIDERS = {
  look: [
    ["tint", 0, 1, 0.05],
    ["opacity", 0, 1, 0.05],
    ["solidity", 0, 1, 0.05],
    ["scanlines", 0, 1, 0.05],
    ["flicker", 0, 1, 0.05],
    ["spin", -0.5, 0.5, 0.01],
    ["lift", 0, 0.5, 0.01]
  ],
  terrain: [
    ["relief", 0, 1.5, 0.05],
    ["resolution", 32, 256, 16],
    ["wire", 0, 1, 0.05],
    ["contours", 0, 1, 0.05]
  ]
};

/**
 * Hologram settings for one Tile. Every change is saved immediately so the hologram updates while you tune it.
 */
export default class HoloConfig extends HandlebarsApplicationMixin(DocumentSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["vira-holo-config"],
    position: {width: 480, height: "auto"},
    window: {icon: "fa-solid fa-cube", contentClasses: ["standard-form"]},
    form: {submitOnChange: true, closeOnSubmit: false},
    actions: {resetView: HoloConfig.#onResetView}
  };

  static PARTS = {
    form: {template: `modules/${MODULE_ID}/templates/holo-config.hbs`, scrollable: [""]}
  };

  /**
   * Open the settings for a tile, or bring them to the front if already open.
   * @param {TileDocument} doc
   */
  static open(doc) {
    const existing = [...foundry.applications.instances.values()]
      .find(app => (app instanceof HoloConfig) && (app.document === doc));
    return (existing ?? new HoloConfig({document: doc})).render({force: true});
  }

  /** @override */
  get title() {
    const {name, texture, id} = this.document;
    const file = texture.src?.split("/").pop();
    const firstLine = getHoloData(this.document).text.content.trim().split("\n")[0].slice(0, 40);
    const label = name || (file && decodeURIComponent(file)) || firstLine || id;
    return game.i18n.format("VIRAHOLO.Config.Title", {name: label});
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const holo = getHoloData(this.document);
    const localize = key => game.i18n.localize(key);
    const sliders = section => SLIDERS[section].map(([key, min, max, step]) => ({
      key, min, max, step,
      name: `flags.${MODULE_ID}.${section}.${key}`,
      value: holo[section][key],
      label: localize(`VIRAHOLO.Config.${section}.${key}`)
    }));
    const FontConfig = foundry.applications.settings?.menus?.FontConfig ?? globalThis.FontConfig;
    return Object.assign(context, {
      holo,
      flags: `flags.${MODULE_ID}`,
      image: this.document.texture.src ?? "",
      isImage: holo.mode === "image",
      isTerrain: holo.mode === "terrain",
      isText: holo.mode === "text",
      modes: Object.fromEntries(["image", "terrain", "text"].map(m => [m, localize(`VIRAHOLO.Mode.${m}`)])),
      fonts: {"": localize("VIRAHOLO.Config.text.defaultFont"), ...FontConfig.getAvailableFontChoices()},
      aligns: Object.fromEntries(["left", "center", "right"].map(a => [a, localize(`VIRAHOLO.Config.text.${a}`)])),
      lookSliders: sliders("look"),
      terrainSliders: sliders("terrain"),
      players: game.users.filter(u => !u.isGM).map(u => ({id: u.id, name: u.name, owner: holo.owners.includes(u.id)}))
    });
  }

  /**
   * Keep only what actually changed. The form shows effective values (defaults included); saving all of them
   * would freeze today's defaults into the tile and stop mode-specific defaults from applying.
   * @override
   */
  _processFormData(event, form, formData) {
    const submitted = foundry.utils.flattenObject(super._processFormData(event, form, formData));
    const current = foundry.utils.flattenObject({
      flags: {[MODULE_ID]: getHoloData(this.document)},
      texture: {src: this.document.texture.src ?? ""}
    });
    // v14 renamed objectsEqual to equals (which also compares primitives and arrays).
    const equals = foundry.utils.equals ?? ((a, b) => foundry.utils.objectsEqual({v: a}, {v: b}));
    const changes = {};
    for ( const [key, value] of Object.entries(submitted) ) {
      if ( !equals(value, current[key]) ) changes[key] = value;
    }
    return foundry.utils.expandObject(changes);
  }

  static async #onResetView() {
    const {mode} = getHoloData(this.document);
    await this.document.update({[`flags.${MODULE_ID}.camera`]: defaultCamera(mode)});
  }
}

/** Ways to open the settings: a button in the Tile HUD and in the Tile config header (GMs only). */
export function registerConfigHooks() {
  Hooks.on("renderTileHUD", (hud, html) => {
    if ( !game.user.isGM ) return;
    const root = (html instanceof HTMLElement) ? html : html[0];
    const column = root?.querySelector(".col.right");
    if ( !column ) return;
    const doc = hud.document ?? hud.object?.document;
    // v12's HUD is AppV1 with div icons; v13+ uses buttons.
    const button = document.createElement(game.release.generation < 13 ? "div" : "button");
    if ( button instanceof HTMLButtonElement ) button.type = "button";
    button.classList.add("control-icon", "vira-holo-hud");
    button.classList.toggle("active", !!doc.getFlag(MODULE_ID, "enabled"));
    button.dataset.tooltip = "VIRAHOLO.Config.Open";
    button.setAttribute("aria-label", game.i18n.localize("VIRAHOLO.Config.Open"));
    button.innerHTML = '<i class="fa-solid fa-cube" inert></i>';
    button.addEventListener("click", () => HoloConfig.open(doc));
    column.append(button);
  });

  // v13+ (ApplicationV2)
  Hooks.on("getHeaderControlsTileConfig", (app, controls) => {
    if ( !game.user.isGM ) return;
    controls.push({icon: "fa-solid fa-cube", label: "VIRAHOLO.Config.Open", onClick: () => HoloConfig.open(app.document)});
  });
  // v12 (Application v1)
  Hooks.on("getTileConfigHeaderButtons", (app, buttons) => {
    if ( !game.user.isGM ) return;
    buttons.unshift({
      label: "VIRAHOLO.Config.Open", class: "vira-holo", icon: "fa-solid fa-cube",
      onclick: () => HoloConfig.open(app.document ?? app.object)
    });
  });
}
