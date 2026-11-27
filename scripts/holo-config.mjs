import {DISPLAY_MODES, OFF_STYLES, SIGN_BASES, SIGN_PANELS, SIGN_SCROLLS, SIGN_TILT_RANGE, allowedDisplays, LINK_SECTIONS, MODULE_ID, UNITS, defaultCamera, deletionUpdate, getHoloData,
  getStateJournal} from "./data.mjs";
import * as history from "./history.mjs";
import {createLink, joinLink, leaveLink, linkChoices, writeHolo} from "./links.mjs";
import {addMapAbove, addMapInside, arrivalCamera, parentChoices, setParent} from "./maps.mjs";
import {saveDriverChanges} from "./socket.mjs";

const {HandlebarsApplicationMixin, DocumentSheetV2} = foundry.applications.api;

/** [key, min, max, step] for each slider, grouped by the flag section they edit. */
const SLIDERS = {
  look: [
    ["tint", 0, 1, 0.05],
    ["opacity", 0, 1, 0.05],
    ["solidity", 0, 1, 0.05],
    ["scanlines", 0, 1, 0.05],
    ["flicker", 0, 1, 0.05],
    ["lift", 0, 0.5, 0.01],
    ["motes", 0, 1, 0.05]
  ],
  camera: [
    ["spin", -0.5, 0.5, 0.01]
  ],
  terrain: [
    ["relief", 0, 3, 0.05],
    ["resolution", 32, 1024, 16],
    ["wire", 0, 1, 0.05],
    ["contours", 0, 1, 0.05]
  ]
};

/** The settings window's tabs, in order. */
const TABS = [
  {id: "content", icon: "fa-solid fa-cube"},
  {id: "look", icon: "fa-solid fa-palette"},
  {id: "annotations", icon: "fa-solid fa-location-dot"},
  {id: "link", icon: "fa-solid fa-link"},
  {id: "maps", icon: "fa-solid fa-sitemap"},
  {id: "view", icon: "fa-solid fa-sliders"}
];

/**
 * Hologram settings for one Tile. Every change is saved immediately so the hologram updates while you tune it.
 */
export default class HoloConfig extends HandlebarsApplicationMixin(DocumentSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["vira-holo-config"],
    position: {width: 520, height: "auto"},
    window: {icon: "fa-solid fa-cube", contentClasses: ["standard-form"]},
    form: {submitOnChange: true, closeOnSubmit: false},
    actions: {
      resetView: HoloConfig.#onResetView,
      insertImage: HoloConfig.#onInsertImage,
      clearMarkers: HoloConfig.#onClearMarkers,
      clearStrokes: HoloConfig.#onClearStrokes,
      clearMeasures: HoloConfig.#onClearMeasures,
      createLink: HoloConfig.#onCreateLink,
      joinLink: HoloConfig.#onJoinLink,
      leaveLink: HoloConfig.#onLeaveLink,
      openLink: HoloConfig.#onOpenLink,
      addMapAbove: HoloConfig.#onAddMapAbove,
      addMapInside: HoloConfig.#onAddMapInside,
      travel: HoloConfig.#onTravel,
      goHome: HoloConfig.#onGoHome
    }
  };

  static PARTS = {
    tabs: {template: "templates/generic/tab-navigation.hbs"},
    content: {template: `modules/${MODULE_ID}/templates/holo-config-content.hbs`, scrollable: [""]},
    look: {template: `modules/${MODULE_ID}/templates/holo-config-look.hbs`, scrollable: [""]},
    annotations: {template: `modules/${MODULE_ID}/templates/holo-config-annotations.hbs`, scrollable: [""]},
    link: {template: `modules/${MODULE_ID}/templates/holo-config-link.hbs`, scrollable: [""]},
    maps: {template: `modules/${MODULE_ID}/templates/holo-config-maps.hbs`, scrollable: [""]},
    view: {template: `modules/${MODULE_ID}/templates/holo-config-view.hbs`, scrollable: [""]}
  };

  /** @override */
  tabGroups = {sheet: "content"};

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
    return game.i18n.format("VIRAHOLO.Config.Title", {name: this.#label});
  }

  /** A readable name for the hologram: the tile's name, its image's file name, or the first line of its text. */
  get #label() {
    const data = getHoloData(this.document);
    const file = data.image?.split("/").pop();
    const firstLine = data.text.content.trim().split("\n")[0].slice(0, 40);
    return this.document.name || (file && decodeURIComponent(file)) || firstLine || this.document.id;
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
    // v12 declares FontConfig as a top-level class: a global binding, but not a property of globalThis.
    const Fonts = foundry.applications.settings?.menus?.FontConfig ?? FontConfig;
    const choices = linkChoices();
    return Object.assign(context, {
      holo,
      flags: `flags.${MODULE_ID}`,
      tabClasses: "top-tabs",
      tabs: Object.fromEntries(TABS.map(({id, icon}) => {
        const active = this.tabGroups.sheet === id;
        return [id, {
          id, icon, group: "sheet", active,
          cssClass: active ? "active" : "",
          label: `VIRAHOLO.Config.Tabs.${id}`
        }];
      })),
      parentChoices: holo.map.uuid ? parentChoices(holo.map.uuid) : {},
      mapChildren: holo.map.children,
      awayFromHome: !holo.map.home,
      linkChoices: choices,
      hasLinks: !foundry.utils.isEmpty(choices),
      shareOptions: Object.keys(LINK_SECTIONS).map(section => ({
        section, checked: holo.link?.share[section], label: localize(`VIRAHOLO.Link.Share.${section}`)
      })),
      isImage: holo.mode === "image",
      isTerrain: holo.mode === "terrain",
      isText: holo.mode === "text",
      modes: Object.fromEntries(["image", "terrain", "text"].map(m => [m, localize(`VIRAHOLO.Mode.${m}`)])),
      fonts: {"": localize("VIRAHOLO.Config.text.defaultFont"), ...Fonts.getAvailableFontChoices()},
      aligns: Object.fromEntries(["left", "center", "right"].map(a => [a, localize(`VIRAHOLO.Config.text.${a}`)])),
      tiltRange: SIGN_TILT_RANGE,
      signPanels: Object.fromEntries(SIGN_PANELS.map(s => [s, localize(`VIRAHOLO.SignPanel.${s}`)])),
      signBases: Object.fromEntries(SIGN_BASES.map(s => [s, localize(`VIRAHOLO.SignBase.${s}`)])),
      signScrolls: Object.fromEntries(SIGN_SCROLLS.map(s => [s, localize(`VIRAHOLO.SignScroll.${s}`)])),
      lookSliders: sliders("look"),
      terrainSliders: sliders("terrain"),
      displayModes: Object.fromEntries(allowedDisplays(holo.terrain).map(m => [m, localize(`VIRAHOLO.Display.${m}`)])),
      offStyles: Object.fromEntries(OFF_STYLES.map(s => [s, localize(`VIRAHOLO.OffStyle.${s}`)])),
      gridUnit: localize(`VIRAHOLO.Units.${holo.scale.unit}`),
      displayToggles: DISPLAY_MODES.map(m => ({
        name: `flags.${MODULE_ID}.terrain.disabled.${m}`, label: localize(`VIRAHOLO.Display.${m}`), disabled: !!holo.terrain.disabled?.[m]
      })),
      cameraSliders: sliders("camera"),
      markerCount: holo.annotations.markers.length,
      strokeCount: holo.annotations.strokes.length,
      measureCount: holo.annotations.measures.length,
      units: Object.fromEntries(Object.keys(UNITS).map(u => [u, localize(`VIRAHOLO.Units.${u}`)])),
      axes: {width: localize("VIRAHOLO.Config.scale.width"), height: localize("VIRAHOLO.Config.scale.height")},
      players: game.users.filter(u => !u.isGM).map(u => ({id: u.id, name: u.name, owner: holo.owners.includes(u.id)}))
    });
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    const tab = context.tabs[partId];
    if ( tab ) context.tab = tab;
    return context;
  }

  /**
   * Keep only what actually changed. The form shows effective values (defaults included); saving all of them
   * would freeze today's defaults into the tile and stop mode-specific defaults from applying.
   * @override
   */
  _processFormData(event, form, formData) {
    const submitted = foundry.utils.flattenObject(super._processFormData(event, form, formData));
    const holo = getHoloData(this.document);
    const current = foundry.utils.flattenObject({flags: {[MODULE_ID]: holo}});
    // Map fields (under "map", like the hologram data's description of the map) edit the map's journal instead.
    current[`flags.${MODULE_ID}.map.parentUuid`] = holo.map.parent?.uuid ?? "";
    // v14 renamed objectsEqual to equals (which also compares primitives and arrays).
    const equals = foundry.utils.equals ?? ((a, b) => foundry.utils.objectsEqual({v: a}, {v: b}));
    const changes = {};
    for ( const [key, value] of Object.entries(submitted) ) {
      if ( !equals(value, current[key]) ) changes[key] = value;
    }
    return foundry.utils.expandObject(changes);
  }

  /**
   * Save each change where it lives: shared sections in the link's journal, the rest on the tile.
   * @override
   */
  async _processSubmitData(event, form, submitData) {
    const {map, ...changes} = submitData.flags?.[MODULE_ID] ?? {};
    if ( map ) await this.#updateMap(map);
    if ( changes && !foundry.utils.isEmpty(changes) ) await writeHolo(this.document, changes);
    return {};
  }

  /** Rename the map shown, move it to another parent, or give it its own look (or drop it). */
  async #updateMap({name, parentUuid, ownLook}) {
    const data = getHoloData(this.document);
    const map = getStateJournal(data.map.uuid);
    if ( !map ) return;
    if ( name?.trim() ) await map.update({name: name.trim()});
    if ( parentUuid !== undefined ) await setParent(map, parentUuid || null);
    if ( ownLook === undefined ) return;
    const path = `flags.${MODULE_ID}.state.look`;
    await map.update(ownLook ? {[path]: foundry.utils.deepClone(data.look)} : deletionUpdate(path));
  }

  static async #onAddMapAbove() {
    await addMapAbove(this.document, this.#label);
  }

  static async #onAddMapInside() {
    await addMapInside(this.document, this.#label);
  }

  static async #onTravel(event, target) {
    const uuid = target.dataset.uuid;
    saveDriverChanges(this.document, {camera: await arrivalCamera(getHoloData(this.document), uuid), map: uuid});
  }

  static async #onGoHome() {
    saveDriverChanges(this.document, {camera: await arrivalCamera(getHoloData(this.document), null), map: null});
  }

  static async #onCreateLink() {
    await createLink(this.document, this.#label);
  }

  static async #onJoinLink() {
    const uuid = this.element.querySelector("[data-link-choice]")?.value;
    if ( uuid ) await joinLink(this.document, uuid);
  }

  static async #onLeaveLink() {
    await leaveLink(this.document);
  }

  static #onOpenLink() {
    fromUuidSync(getHoloData(this.document).link?.uuid)?.sheet.render(true);
  }

  static async #onClearMarkers() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {title: "VIRAHOLO.Config.clearMarkers"},
      content: `<p>${game.i18n.localize("VIRAHOLO.Config.clearMarkersConfirm")}</p>`
    });
    if ( !confirmed ) return;
    history.edit(this.document, "markers", {type: "clear"}, getHoloData(this.document).annotations.markers);
  }

  static async #onClearStrokes() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {title: "VIRAHOLO.Config.clearStrokes"},
      content: `<p>${game.i18n.localize("VIRAHOLO.Config.clearStrokesConfirm")}</p>`
    });
    if ( !confirmed ) return;
    history.edit(this.document, "strokes", {type: "clear"}, getHoloData(this.document).annotations.strokes);
  }

  static async #onClearMeasures() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {title: "VIRAHOLO.Config.clearMeasures"},
      content: `<p>${game.i18n.localize("VIRAHOLO.Config.clearMeasuresConfirm")}</p>`
    });
    if ( !confirmed ) return;
    history.edit(this.document, "measures", {type: "clear"}, getHoloData(this.document).annotations.measures);
  }

  /** Pick an image and put a line showing it at the text cursor (on a line of its own). */
  static #onInsertImage() {
    const textarea = this.element.querySelector(`textarea[name="flags.${MODULE_ID}.text.content"]`);
    if ( !textarea ) return;
    const Picker = foundry.applications.apps?.FilePicker?.implementation ?? FilePicker;
    new Picker({
      type: "image",
      callback: path => {
        const {value, selectionStart: at} = textarea;
        const before = value.slice(0, at);
        const after = value.slice(at);
        const line = `![](${path.replaceAll(" ", "%20")})`;
        textarea.value = `${before}${(before && !before.endsWith("\n")) ? "\n" : ""}${line}${after.startsWith("\n") ? "" : "\n"}${after}`;
        textarea.dispatchEvent(new Event("change", {bubbles: true}));
      }
    }).render(true);
  }

  static async #onResetView() {
    const {mode} = getHoloData(this.document);
    await this.document.update({[`flags.${MODULE_ID}.camera`]: defaultCamera(mode)});
  }
}

/** Ways to open the settings: a button in the Tile HUD and in the Tile config header (GMs only). */
export function registerConfigHooks() {
  // Shared settings live in link journals, which are also maps (shown, parents, children); keep open windows current.
  const refresh = journal => {
    if ( !journal.flags[MODULE_ID] ) return;
    for ( const app of foundry.applications.instances.values() ) {
      if ( app instanceof HoloConfig ) app.render();
    }
  };
  Hooks.on("createJournalEntry", refresh);
  Hooks.on("updateJournalEntry", refresh);
  Hooks.on("deleteJournalEntry", refresh);
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
