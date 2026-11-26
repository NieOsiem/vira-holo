import {DEFAULT_SHARE, LINK_SECTIONS, MODULE_ID, deletionUpdate, getHoloData, getLink, getMaps,
  sectionOf} from "./data.mjs";

/**
 * Save hologram changes where they live (see storageOf): the map travelled to, the link's journal or the tile (an
 * unlinked image is the tile's own texture). GM side only; drivers' changes reach this through the active GM.
 * @param {TileDocument} doc
 * @param {object} changes   In the shape of the hologram data, e.g. {camera: {...}} or {annotations: {markers}}
 */
export async function writeHolo(doc, changes) {
  /** @type {Map<ClientDocument, object>} */
  const targets = new Map();
  for ( const [key, value] of Object.entries(changes) ) {
    const target = storageOf(doc, sectionOf(key));
    if ( !targets.has(target) ) targets.set(target, {});
    targets.get(target)[key] = value;
  }
  const writes = [];
  for ( const [target, values] of targets ) {
    if ( target !== doc ) {
      writes.push(target.update({[`flags.${MODULE_ID}.state`]: values}));
      continue;
    }
    const {image, ...flags} = values;
    const update = {};
    if ( !foundry.utils.isEmpty(flags) ) update[`flags.${MODULE_ID}`] = flags;
    if ( image !== undefined ) update["texture.src"] = image;
    if ( !foundry.utils.isEmpty(update) ) writes.push(doc.update(update));
  }
  return Promise.all(writes);
}

/**
 * The document that stores a section for this tile: away from home, the map shown stores its content and
 * annotations (and its look, if it has its own); otherwise the link's journal if the section is shared, else the
 * tile itself.
 * @param {TileDocument} doc
 * @param {string} [section]
 */
export function storageOf(doc, section) {
  const link = getLink(doc);
  const {away} = getMaps(doc, link);
  if ( away ) {
    const own = (section === "look") && !!away.getFlag(MODULE_ID, "state").look;
    if ( (section === "content") || (section === "annotations") || own ) return away;
  }
  return (section && link?.share[section]) ? link.journal : doc;
}

/** Every shareable part of a hologram, as it currently looks. */
function snapshot(doc) {
  const data = getHoloData(doc);
  const state = {};
  for ( const keys of Object.values(LINK_SECTIONS) ) {
    for ( const key of keys ) state[key] = foundry.utils.deepClone(data[key]);
  }
  return state;
}

/** Journal entries that are hologram links, as {uuid: name}. */
export function linkChoices() {
  const links = game.journal.filter(j => j.getFlag(MODULE_ID, "state"));
  return Object.fromEntries(links.map(j => [j.uuid, j.name]));
}

async function linksFolder() {
  const existing = game.folders.find(f => (f.type === "JournalEntry") && f.getFlag(MODULE_ID, "links"));
  if ( existing ) return existing;
  return Folder.create({
    name: game.i18n.localize("VIRAHOLO.Link.Folder"), type: "JournalEntry", flags: {[MODULE_ID]: {links: true}}
  });
}

/**
 * Start a new link from a hologram: a journal entry seeded with how it looks now, which the tile then follows.
 * @param {TileDocument} doc
 * @param {string} name
 */
export async function createLink(doc, name) {
  const journal = await createStateJournal(name, snapshot(doc));
  await doc.update({[`flags.${MODULE_ID}.link`]: {uuid: journal.uuid, share: {...DEFAULT_SHARE}}});
  return journal;
}

/**
 * A new link (or map) journal entry in the Holo Links folder.
 * @param {string} name
 * @param {object} state   In the shape of the hologram data
 * @returns {Promise<JournalEntry>}
 */
export async function createStateJournal(name, state) {
  const folder = await linksFolder();
  return JournalEntry.create({
    name, folder: folder.id,
    flags: {[MODULE_ID]: {state}},
    pages: [{
      name: game.i18n.localize("VIRAHOLO.Link.PageName"),
      type: "text",
      text: {content: `<p>${game.i18n.localize("VIRAHOLO.Link.PageText")}</p>`}
    }]
  });
}

/**
 * Make a tile follow an existing link.
 * @param {TileDocument} doc
 * @param {string} uuid
 */
export async function joinLink(doc, uuid) {
  await doc.update({[`flags.${MODULE_ID}.link`]: {uuid, share: {...DEFAULT_SHARE}}});
}

/**
 * Stop following the link, keeping what the tile shows: the shared parts are copied into the tile first.
 * @param {TileDocument} doc
 */
export async function leaveLink(doc) {
  const link = getLink(doc);
  const update = deletionUpdate(`flags.${MODULE_ID}.link`);
  if ( link ) {
    const data = getHoloData(doc);
    for ( const [section, keys] of Object.entries(LINK_SECTIONS) ) {
      if ( !link.share[section] ) continue;
      for ( const key of keys ) {
        if ( key === "image" ) update["texture.src"] = data.image;
        else update[`flags.${MODULE_ID}.${key}`] = foundry.utils.deepClone(data[key]);
      }
    }
  }
  await doc.update(update);
}
