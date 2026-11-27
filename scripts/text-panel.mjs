const PADDING = 0.06;
const MAX_SIZE = 4096;
/** Fewest texture pixels per scene pixel, a little above 1 so text stays crisp at normal zoom. */
const OVERSAMPLE = 1.25;
/**
 * Texture pixels per scene pixel that pages are laid out (measured, wrapped, shrunk to fit) at, whatever the
 * resolution they are drawn at: zooming never reflows a sign. Measured sizes are rounded to whole pixels, so a low
 * scale makes text that only just fits shrink a step.
 */
const LAYOUT_SCALE = 4;
/** Smallest font, in scene pixels. */
const MIN_FONT_SIZE = 4.8;
const LINE_HEIGHT = 1.2;
const ANCHORS = {left: 0, center: 0.5, right: 1};
/** A line that is only an image, written like Markdown: ![](path/to/image.webp) */
const IMAGE_LINE = /^\s*!\[[^\]]*\]\(\s*(\S+?)\s*\)\s*$/;
/** A line of three or more dashes starts a new page. */
const PAGE_BREAK = /^\s*-{3,}\s*$/;
/** Scroll pace at speed 1: lines per second upwards, font sizes per second sideways. */
const SCROLL_UP = 0.7;
const SCROLL_LEFT = 2.4;
/** Images share a page with text only if each can be at least this much of the page's height (or their own). */
const MIN_IMAGE_SHARE = 0.3;

/**
 * Split sign content into pages of blocks: runs of text, and images on lines of their own.
 * @param {string} content
 * @returns {({type: "text", text: string}|{type: "image", src: string})[][]}   At least one (maybe empty) page
 */
export function parsePages(content) {
  const pages = [[]];
  let lines = [];
  const flush = () => {
    const text = lines.join("\n").replace(/^\s*\n/, "").trimEnd();
    if ( text.trim() ) pages.at(-1).push({type: "text", text});
    lines = [];
  };
  for ( const line of content.split(/\r?\n/) ) {
    if ( PAGE_BREAK.test(line) ) {
      flush();
      pages.push([]);
      continue;
    }
    const image = line.match(IMAGE_LINE);
    if ( !image ) {
      lines.push(line);
      continue;
    }
    flush();
    pages.at(-1).push({type: "image", src: image[1]});
  }
  flush();
  const filled = pages.filter(blocks => blocks.length);
  return filled.length ? filled : [[]];
}

/** In-game date and time placeholders: {{date}}, {{time}}, {{weekday}}. */
const PLACEHOLDER = /\{\{\s*(date|time|weekday)\s*\}\}/i;
const PLACEHOLDERS = new RegExp(PLACEHOLDER.source, "gi");

/**
 * The in-game date, time or weekday: from Simple Calendar when it runs (what players see in its widget), else the
 * core calendar (v13+), else days and hours counted from the world time.
 * @param {"date"|"time"|"weekday"} kind
 * @returns {string}
 */
export function worldTimeText(kind) {
  const display = globalThis.SimpleCalendar?.api?.currentDateTimeDisplay?.();
  if ( display ) {
    if ( kind === "weekday" ) return display.weekday ?? "";
    if ( kind === "date" ) return display.date ?? "";
    return (display.time ?? "").replace(/^(\d+:\d\d):\d\d$/, "$1"); // Signs show minutes, not seconds
  }
  const pad = n => String(n).padStart(2, "0");
  const calendar = game.time.calendar;
  const c = calendar && game.time.components;
  if ( c ) {
    if ( kind === "time" ) return `${pad(c.hour)}:${pad(c.minute)}`;
    if ( kind === "weekday" ) {
      const day = calendar.days?.values?.[c.dayOfWeek];
      return day ? game.i18n.localize(day.name) : "";
    }
    const month = calendar.months?.values?.[c.month];
    return `${c.dayOfMonth + 1} ${month ? game.i18n.localize(month.name) : c.month + 1} ${c.year}`;
  }
  const time = game.time.worldTime;
  if ( kind === "time" ) return `${pad(Math.floor(time / 3600) % 24)}:${pad(Math.floor(time / 60) % 60)}`;
  return kind === "date" ? game.i18n.format("VIRAHOLO.Day", {day: Math.floor(time / 86400) + 1}) : "";
}

function fillPlaceholders(content) {
  return content.replace(PLACEHOLDERS, (_, kind) => worldTimeText(kind.toLowerCase()));
}

/**
 * A sign's pages of blocks, from its own text or from a journal: each text page of an entry (or the one page
 * chosen) is a page of the sign, split further at horizontal rules; image pages show their image.
 * @param {object} text   The hologram's text data
 * @returns {Promise<{pages: object[][], usesTime: boolean}>}
 */
async function sourcePages(text) {
  if ( text.source !== "journal" ) {
    const content = text.content ?? "";
    return {pages: parsePages(fillPlaceholders(content)), usesTime: PLACEHOLDER.test(content)};
  }
  const doc = text.journal ? await fromUuid(text.journal).catch(() => null) : null;
  let entries = [];
  if ( doc?.documentName === "JournalEntry" ) entries = doc.pages.contents.sort((a, b) => a.sort - b.sort);
  else if ( doc?.documentName === "JournalEntryPage" ) entries = [doc];
  // v12 declares TextEditor as a top-level class: a global binding, but not a property of globalThis.
  const Editor = foundry.applications.ux?.TextEditor?.implementation ?? TextEditor;
  const pages = [];
  let usesTime = false;
  for ( const page of entries ) {
    if ( (page.type === "image") && page.src ) pages.push([{type: "image", src: page.src}]);
    if ( page.type !== "text" ) continue;
    const content = page.text?.content ?? "";
    usesTime ||= PLACEHOLDER.test(content);
    // Secrets stay secret: everyone can see a sign.
    const html = await Editor.enrichHTML(fillPlaceholders(content), {secrets: false, rolls: false, relativeTo: page});
    pages.push(...htmlPages(html));
  }
  return {pages: pages.length ? pages : [[]], usesTime};
}

/**
 * Split journal HTML into pages of blocks: horizontal rules start a page, images become image blocks of their own
 * (an SVG-rendered HTML block can't load them), and everything else stays HTML.
 * @param {string} html
 * @returns {object[][]}
 */
function htmlPages(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  // Icons (content links) have no font in the rendered HTML; scripts and styles don't belong on a sign.
  template.content.querySelectorAll("script, style, i[class*='fa-'], .secret").forEach(node => node.remove());
  const pages = [[]];
  let buffer = [];
  const flush = () => {
    const chunk = buffer.join("").trim();
    buffer = [];
    const probe = document.createElement("div");
    probe.innerHTML = chunk;
    if ( probe.textContent.trim() ) pages.at(-1).push({type: "html", html: chunk});
  };
  for ( const node of Array.from(template.content.childNodes) ) {
    if ( node.nodeName === "HR" ) {
      flush();
      pages.push([]);
      continue;
    }
    if ( node.nodeType !== Node.ELEMENT_NODE ) {
      if ( node.textContent.trim() ) buffer.push(foundry.utils.escapeHTML?.(node.textContent) ?? node.textContent);
      continue;
    }
    const images = node.matches("img") ? [node] : Array.from(node.querySelectorAll("img"));
    if ( !images.length ) {
      buffer.push(node.outerHTML);
      continue;
    }
    const sources = images.map(img => img.getAttribute("src")).filter(Boolean);
    for ( const img of images ) img.remove();
    if ( node.textContent.trim() ) buffer.push(node.outerHTML);
    flush();
    for ( const src of sources ) pages.at(-1).push({type: "image", src});
  }
  flush();
  const filled = pages.filter(blocks => blocks.length);
  return filled.length ? filled : [[]];
}

/** Plain text of an HTML block, one line per block element, for the ticker. */
function htmlText(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes, node => node.textContent.trim()).filter(Boolean).join("\n");
}

/** Styles for journal HTML on a sign: one per font family, kept, with the family's font files embedded once. */
const htmlStyles = new Map();
// Blocks are measured in the page (where Foundry's own styles for h1, p, ... apply) but drawn in an isolated SVG
// image (where they don't), so everything that changes a block's size is set here explicitly for both.
const HTML_CSS = `
  p, ul, ol, blockquote, table, h1, h2, h3, h4, h5, h6 {
    margin: 0 0 0.4em; padding: 0; border: none; line-height: 1.2; font-family: inherit; letter-spacing: normal;
    text-transform: none; color: inherit; background: none; box-shadow: none; text-shadow: inherit;
  }
  h1, h2, h3, h4, h5, h6 { margin-bottom: 0.25em; line-height: 1.1; font-weight: bold; }
  h1 { font-size: 2em; } h2 { font-size: 1.6em; } h3 { font-size: 1.35em; } h4 { font-size: 1.15em; }
  h5, h6 { font-size: 1em; }
  ul, ol { padding-left: 1.2em; text-align: left; }
  li { margin: 0; padding: 0; line-height: 1.2; }
  a { color: inherit; text-decoration: none; border: none; background: none; padding: 0; }
  table { border-collapse: collapse; }
  td, th { padding: 0.1em 0.4em; }
`;

/**
 * A rendered HTML block has no access to the page's web fonts (it is an SVG image), so a family's font files from
 * CONFIG.fontDefinitions are loaded into its style; system fonts need nothing.
 */
async function htmlStyle(fontFamily) {
  if ( htmlStyles.has(fontFamily) ) return htmlStyles.get(fontFamily);
  const style = new PIXI.HTMLTextStyle({fontFamily, fill: "#ffffff", whiteSpace: "normal", wordWrap: true,
    breakWords: false, dropShadow: true, dropShadowColor: "#ffffff", dropShadowAlpha: 0.5, dropShadowDistance: 0});
  style.stylesheet = HTML_CSS;
  const definition = CONFIG.fontDefinitions?.[fontFamily];
  const loads = (definition?.fonts ?? []).flatMap(font => (font.urls ?? []).slice(0, 1).map(url => style.loadFont(url, {
    family: fontFamily, weight: font.weight ?? "normal", style: font.style ?? "normal"
  }).catch(err => console.warn(`Vira Holo | Could not load font file "${url}"`, err))));
  await Promise.all(loads);
  htmlStyles.set(fontFamily, style);
  return style;
}

async function loadImage(src) {
  const loadTexture = foundry.canvas.loadTexture ?? globalThis.loadTexture;
  try {
    const texture = await loadTexture(src);
    return texture?.width ? texture : null;
  } catch(err) {
    console.warn(`Vira Holo | Could not load sign image "${src}"`, err);
    return null;
  }
}

/**
 * Renders a sign's pages, white text and images on transparent, into one texture per page. A page that scrolls gets
 * a texture longer than the panel along the scroll, which the panel shows a window of (see `window` and `rate`).
 * Pages are only re-rendered when their content, style or the panel size change.
 */
export default class TextPanel {
  /**
   * @type {{texture: PIXI.RenderTexture, window: number[], rate: number[], targets: number[][]}[]}
   * window: the share of the texture (u, v) the panel shows; rate: how far that window moves per second (u, v);
   * targets: where on the panel there is something to see, as [u0, v0, u1, v1] boxes (lines of text, images).
   */
  pages = [];
  /** Whether the content shows the in-game date or time (re-render when it changes). */
  usesTime = false;
  #key = "";
  /**
   * Pages laid out at LAYOUT_SCALE, kept while content, font and panel size stay the same: a new resolution (zoom)
   * only redraws them. Measuring HTML is slow (each measure restyles the whole document).
   */
  #layouts = [];
  #layoutKey = "";
  #request = 0;
  #destroyed = false;

  /**
   * @param {object} text     The hologram's text data (content, font, size, align, scroll, speed)
   * @param {number} width    Panel width in scene pixels
   * @param {number} height   Panel height in scene pixels
   * @param {number} [devicePixels=1]   Device pixels per scene pixel on screen, so zoomed-in text stays sharp
   * @param {number} [squash=1]   How much the panel's height is foreshortened on screen: textures are that much
   *                              shorter (pages are laid out at full height and squashed into them)
   */
  async update(text, width, height, devicePixels=1, squash=1) {
    const font = text.font || CONFIG.defaultFontFamily || "Signika";
    const density = Math.round(Math.max(OVERSAMPLE, devicePixels) * 1000) / 1000;
    const request = ++this.#request;
    const {pages, usesTime} = await sourcePages(text);
    if ( (request !== this.#request) || this.#destroyed ) return; // Superseded or destroyed meanwhile
    this.usesTime = usesTime;
    const layoutKey = JSON.stringify([pages, font, text.size, text.align, text.scroll, Math.round(width),
      Math.round(height)]);
    const key = JSON.stringify([layoutKey, text.speed, density, squash]);
    if ( key === this.#key ) return;
    this.#key = key;
    // Foundry's texture cache may have evicted (destroyed) an image since the layout was made.
    const evicted = this.#layouts.some(layout => layout.items.some(item => item.texture && !item.texture.baseTexture));
    if ( (layoutKey !== this.#layoutKey) || evicted ) {
      try {
        await document.fonts.load(`32px "${font}"`);
      } catch(err) {
        console.warn(`Vira Holo | Could not load font "${font}"`, err);
      }
      const html = pages.flat().some(b => b.type === "html") ? await htmlStyle(font) : null;
      const sources = [...new Set(pages.flat().filter(b => b.type === "image").map(b => b.src))];
      const images = new Map(await Promise.all(sources.map(async src => [src, await loadImage(src)])));
      if ( (key !== this.#key) || this.#destroyed ) return;
      const options = {font, size: text.size, align: text.align, scroll: text.scroll, width, height, html};
      this.#layouts = pages.map(blocks => layoutPage(blocks, images, options));
      this.#layoutKey = layoutKey;
    }
    // One page at a time: pages share the font family's HTML style, which each draws with its own sizes.
    const layouts = this.#layouts;
    const rendered = [];
    for ( const layout of layouts ) rendered.push(await renderPage(layout, {density, squash, speed: text.speed}));
    if ( (key !== this.#key) || this.#destroyed ) {
      for ( const page of rendered ) page.texture.destroy(true);
      return;
    }
    const old = this.pages;
    this.pages = rendered;
    for ( const page of old ) page.texture.destroy(true);
  }

  destroy() {
    this.#destroyed = true;
    this.#key = "";
    this.#layouts = [];
    this.#layoutKey = "";
    for ( const page of this.pages ) page.texture.destroy(true);
    this.pages = [];
  }
}

/**
 * Lay out one page at LAYOUT_SCALE texture pixels per scene pixel, with where its content is on the panel.
 * @returns {object}   The layout (see layoutColumn/layoutTicker) plus what renderPage needs to draw it
 */
function layoutPage(blocks, images, {font, size, align, scroll, width, height, html}) {
  const items = blocks.map(block => ((block.type === "image") ? {...block, texture: images.get(block.src)} : block))
    .filter(block => (block.type !== "image") || block.texture);
  const lay = scroll === "left" ? layoutTicker : layoutColumn;
  const scale = Math.min(LAYOUT_SCALE, MAX_SIZE / Math.max(width, height, 1));
  const measurer = html ? new PIXI.HTMLText("", html) : null;
  if ( measurer ) measurer.maxWidth = measurer.maxHeight = MAX_SIZE;
  const layout = lay(items, {font, size, align, scroll, width, height, html, measurer, scale});
  measurer?.destroy();
  // Targets on the panel (its window onto the texture). Scrolling content passes through the whole window.
  const panelW = width * scale;
  const panelH = height * scale;
  let targets = layout.targets.map(([x0, y0, x1, y1]) => [x0 / panelW, y0 / panelH, x1 / panelW, y1 / panelH]);
  if ( targets.length && (scroll === "up") ) {
    targets = [[Math.min(...targets.map(t => t[0])), 0.1, Math.max(...targets.map(t => t[2])), 0.9]];
  } else if ( targets.length && (scroll === "left") ) {
    targets = [[0.06, Math.min(...targets.map(t => t[1])), 0.94, Math.max(...targets.map(t => t[3]))]];
  }
  return {
    ...layout, targets, scale, html, align, scroll,
    window: [Math.min(1, panelW / layout.width), Math.min(1, panelH / layout.height)]
  };
}

/**
 * Draw a laid-out page into a texture at `density` texture pixels per scene pixel (texts are drawn at that
 * resolution rather than laid out again), its height squashed by `squash`.
 */
async function renderPage(layout, {density, squash, speed}) {
  const {html, scroll} = layout;
  const zoom = Math.min(density / layout.scale, MAX_SIZE / Math.max(layout.width, layout.height, 1));
  if ( layout.items.some(item => item.html) ) setHtmlSize(html, layout.align, layout.fontSize, layout.wrapWidth);
  const container = new PIXI.Container();
  const rendering = [];
  for ( const item of layout.items ) {
    let object;
    if ( item.texture ) {
      object = new PIXI.Sprite(item.texture);
      object.width = item.w;
      object.height = item.h;
      object.position.set(item.x, item.y);
    } else {
      if ( item.html ) {
        object = new PIXI.HTMLText(item.html, html);
        object.maxWidth = object.maxHeight = MAX_SIZE;
      }
      else object = new PIXI.Text(item.text, item.style);
      object.resolution = zoom;
      if ( item.html ) rendering.push(object.updateText(false));
      object.anchor.set(item.anchor, 0);
      object.position.set(item.x, item.y);
    }
    container.addChild(object);
  }
  await Promise.all(rendering); // HTML blocks are drawn as images, which load asynchronously
  container.scale.set(zoom, zoom * squash);
  const w = Math.max(2, Math.ceil(layout.width * zoom));
  const h = Math.max(2, Math.ceil(layout.height * zoom * squash));
  const texture = PIXI.RenderTexture.create({width: w, height: h});
  canvas.app.renderer.render(container, {renderTexture: texture, clear: true});
  // Text textures go with it; image textures belong to Foundry's cache, and the HTML style is kept for reuse.
  container.destroy({children: true});
  const pace = layout.pace * speed;
  return {
    texture, targets: layout.targets, window: layout.window,
    rate: scroll === "left" ? [pace / layout.width, 0] : (scroll === "up" ? [0, pace / layout.height] : [0, 0])
  };
}

function setHtmlSize(style, align, size, wrapWidth) {
  Object.assign(style, {align, fontSize: size, wordWrapWidth: wrapWidth, dropShadowBlur: size * 0.25,
    padding: Math.ceil(size * 0.3)});
}

function textStyle(fontFamily, align, size, wrapWidth=null) {
  return new PIXI.TextStyle({
    fontFamily, align, fill: "#ffffff", fontSize: size, lineHeight: size * LINE_HEIGHT,
    wordWrap: wrapWidth !== null, breakWords: true, wordWrapWidth: wrapWidth ?? 0,
    dropShadow: true, dropShadowColor: "#ffffff", dropShadowAlpha: 0.5, dropShadowDistance: 0,
    dropShadowBlur: size * 0.25, padding: Math.ceil(size * 0.3)
  });
}

/**
 * Blocks stacked down the panel, in texture pixels (at `scale` per scene pixel, before squashing). Fixed pages shrink
 * their font until text and images fit; scrolling pages keep it and grow as long as they need, plus a panel's
 * height of space before the content comes round again.
 */
function layoutColumn(items, {font, size, align, scroll, width, height, scale, html, measurer}) {
  const W = width * scale;
  const H = height * scale;
  const pad = Math.round(Math.min(W, H) * PADDING);
  const innerW = W - (2 * pad);
  const innerH = H - (2 * pad);
  const anchor = ANCHORS[align] ?? 0.5;
  const scrolling = scroll === "up";
  const images = items.filter(item => item.texture);
  const natural = item => innerW * (item.texture.height / item.texture.width);
  const minFontSize = MIN_FONT_SIZE * scale;
  let fontSize = Math.max(size * scale, minFontSize);
  let style;
  let heights;
  // Size of a text or HTML block at the current font size (HTML measured without its padding).
  const measure = item => {
    if ( !item.html ) return PIXI.TextMetrics.measureText(item.text, style);
    const {width: w, height: h} = measurer.measureText({text: item.html});
    return {width: w - (2 * html.padding), height: h - (2 * html.padding)};
  };
  for ( ;; ) {
    style = textStyle(font, align, fontSize, innerW);
    if ( html ) setHtmlSize(html, align, fontSize, innerW);
    const gap = fontSize * 0.5;
    const textHeight = items.reduce((sum, item) => sum + (item.texture ? 0 : measure(item).height), 0)
      + (gap * Math.max(items.length - 1, 0));
    const share = images.length ? (innerH - textHeight) / images.length : 0;
    heights = item => (item.texture ? Math.min(natural(item), scrolling ? innerH : Math.max(share, 0)) : null);
    const fits = scrolling || (images.length
      ? images.every(item => share >= Math.min(natural(item), innerH * MIN_IMAGE_SHARE))
      : textHeight <= innerH);
    if ( fits || (fontSize <= minFontSize) ) break;
    fontSize = Math.max(fontSize * 0.9, minFontSize);
  }

  const gap = fontSize * 0.5;
  const placed = items.map(item => {
    if ( item.texture ) {
      const h = heights(item);
      const w = h * (item.texture.width / item.texture.height);
      return {texture: item.texture, w, h};
    }
    const {width: w, height: h} = measure(item);
    return item.html ? {html: item.html, anchor, w, h} : {text: item.text, style, anchor, h};
  });
  const contentHeight = placed.reduce((sum, item) => sum + item.h, 0) + (gap * Math.max(placed.length - 1, 0));
  let y = scrolling ? pad : pad + Math.max(0, (innerH - contentHeight) / 2);
  const targets = [];
  for ( const item of placed ) {
    item.x = item.texture ? pad + (anchor * (innerW - item.w)) : pad + (anchor * innerW);
    item.y = y;
    if ( item.texture ) targets.push([item.x, y, item.x + item.w, y + item.h]);
    else if ( item.html ) targets.push([item.x - (anchor * item.w), y, item.x + ((1 - anchor) * item.w), y + item.h]);
    else {
      // Each line's body: lines are aligned like the block, so each starts where the anchor puts its own width.
      const {lines, lineWidths, lineHeight} = PIXI.TextMetrics.measureText(item.text, style);
      lines.forEach((line, i) => {
        if ( !line.trim() ) return;
        const x0 = item.x - (anchor * lineWidths[i]);
        const top = y + (i * lineHeight);
        targets.push([x0, top + (lineHeight * 0.2), x0 + lineWidths[i], top + (lineHeight * 0.8)]);
      });
    }
    y += item.h + gap;
  }
  return {
    items: placed, width: W, targets, fontSize, wrapWidth: innerW,
    height: scrolling ? contentHeight + (2 * pad) + H : H,
    pace: fontSize * LINE_HEIGHT * SCROLL_UP
  };
}

/** Blocks in one line along the panel, like a news ticker: text on a single line, images as tall as the text allows. */
function layoutTicker(items, {font, size, align, width, height, scale}) {
  const W = width * scale;
  const H = height * scale;
  const pad = Math.round(H * PADDING);
  const innerH = H - (2 * pad);
  const fontSize = Math.max(Math.min(size * scale, innerH / LINE_HEIGHT), MIN_FONT_SIZE * scale);
  const style = textStyle(font, align, fontSize);
  const gap = fontSize * 2;
  const placed = [];
  let x = gap / 2;
  for ( const item of items ) {
    if ( item.texture ) {
      const h = Math.min(innerH, fontSize * LINE_HEIGHT * 2.5);
      const w = h * (item.texture.width / item.texture.height);
      placed.push({texture: item.texture, w, h, x, y: (H - h) / 2, target: [0, (H - h) / 2, 0, (H + h) / 2]});
      x += w + gap;
      continue;
    }
    const text = (item.html ? htmlText(item.html) : item.text).split("\n").map(line => line.trim()).filter(Boolean)
      .join("   •   ");
    const metrics = PIXI.TextMetrics.measureText(text, style);
    placed.push({text, style, anchor: 0, x, y: (H - metrics.height) / 2,
      target: [0, (H - (fontSize * 0.6)) / 2, 0, (H + (fontSize * 0.6)) / 2]});
    x += metrics.width + gap;
  }
  return {items: placed, width: Math.max(W, x + (gap / 2)), height: H, pace: fontSize * SCROLL_LEFT,
    targets: placed.map(item => item.target)};
}
