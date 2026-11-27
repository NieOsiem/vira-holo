const PADDING = 0.06;
const MAX_SIZE = 4096;
/** Fewest texture pixels per scene pixel, a little above 1 so text stays crisp at normal zoom. */
const OVERSAMPLE = 1.25;
const MIN_FONT_SIZE = 6;
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
   * @type {{texture: PIXI.RenderTexture, window: number[], rate: number[]}[]}
   * window: the share of the texture (u, v) the panel shows; rate: how far that window moves per second (u, v).
   */
  pages = [];
  #key = "";
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
    const key = JSON.stringify([text.content, font, text.size, text.align, text.scroll, text.speed,
      Math.round(width), Math.round(height), density, squash]);
    if ( key === this.#key ) return;
    this.#key = key;
    try {
      await document.fonts.load(`32px "${font}"`);
    } catch(err) {
      console.warn(`Vira Holo | Could not load font "${font}"`, err);
    }
    const pages = parsePages(text.content ?? "");
    const sources = [...new Set(pages.flat().filter(b => b.type === "image").map(b => b.src))];
    const images = new Map(await Promise.all(sources.map(async src => [src, await loadImage(src)])));
    if ( (key !== this.#key) || this.#destroyed ) return; // Superseded or destroyed while loading
    const options = {font, size: text.size, align: text.align, scroll: text.scroll, speed: text.speed, width, height,
      density, squash};
    const rendered = pages.map(blocks => this.#renderPage(blocks, images, options));
    const old = this.pages;
    this.pages = rendered;
    for ( const page of old ) page.texture.destroy(true);
  }

  #renderPage(blocks, images, {font, size, align, scroll, speed, width, height, density, squash}) {
    const items = blocks.map(block => ((block.type === "image") ? {...block, texture: images.get(block.src)} : block))
      .filter(block => (block.type === "text") || block.texture);
    const lay = scroll === "left" ? layoutTicker : layoutColumn;
    let scale = Math.min(density, MAX_SIZE / Math.max(width, height, 1));
    let layout = lay(items, {font, size, align, scroll, width, height, scale});
    const extent = Math.max(layout.width, layout.height);
    if ( extent > MAX_SIZE ) {
      scale *= MAX_SIZE / extent;
      layout = lay(items, {font, size, align, scroll, width, height, scale});
    }

    const container = new PIXI.Container();
    for ( const item of layout.items ) {
      let object;
      if ( item.texture ) {
        object = new PIXI.Sprite(item.texture);
        object.width = item.w;
        object.height = item.h;
        object.position.set(item.x, item.y);
      } else {
        object = new PIXI.Text(item.text, item.style);
        object.resolution = 1;
        object.anchor.set(item.anchor, 0);
        object.position.set(item.x, item.y);
      }
      container.addChild(object);
    }
    container.scale.y = squash;
    const w = Math.max(2, Math.ceil(layout.width));
    const h = Math.max(2, Math.ceil(layout.height * squash));
    const texture = PIXI.RenderTexture.create({width: w, height: h});
    canvas.app.renderer.render(container, {renderTexture: texture, clear: true});
    container.destroy({children: true}); // Text textures go with it; image textures belong to Foundry's cache
    const pace = layout.pace * speed;
    return {
      texture,
      window: [Math.min(1, (width * scale) / layout.width), Math.min(1, (height * scale) / layout.height)],
      rate: scroll === "left" ? [pace / layout.width, 0] : (scroll === "up" ? [0, pace / layout.height] : [0, 0])
    };
  }

  destroy() {
    this.#destroyed = true;
    this.#key = "";
    for ( const page of this.pages ) page.texture.destroy(true);
    this.pages = [];
  }
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
function layoutColumn(items, {font, size, align, scroll, width, height, scale}) {
  const W = width * scale;
  const H = height * scale;
  const pad = Math.round(Math.min(W, H) * PADDING);
  const innerW = W - (2 * pad);
  const innerH = H - (2 * pad);
  const anchor = ANCHORS[align] ?? 0.5;
  const scrolling = scroll === "up";
  const images = items.filter(item => item.texture);
  const natural = item => innerW * (item.texture.height / item.texture.width);
  let fontSize = Math.max(size * scale, MIN_FONT_SIZE);
  let style;
  let heights;
  for ( ;; ) {
    style = textStyle(font, align, fontSize, innerW);
    const gap = fontSize * 0.5;
    const textHeight = items.reduce((sum, item) => sum + (item.texture ? 0 : PIXI.TextMetrics.measureText(item.text, style).height), 0)
      + (gap * Math.max(items.length - 1, 0));
    const share = images.length ? (innerH - textHeight) / images.length : 0;
    heights = item => (item.texture ? Math.min(natural(item), scrolling ? innerH : Math.max(share, 0)) : null);
    const fits = scrolling || (images.length
      ? images.every(item => share >= Math.min(natural(item), innerH * MIN_IMAGE_SHARE))
      : textHeight <= innerH);
    if ( fits || (fontSize <= MIN_FONT_SIZE) ) break;
    fontSize = Math.max(fontSize * 0.9, MIN_FONT_SIZE);
  }

  const gap = fontSize * 0.5;
  const placed = items.map(item => {
    if ( item.texture ) {
      const h = heights(item);
      const w = h * (item.texture.width / item.texture.height);
      return {texture: item.texture, w, h};
    }
    return {text: item.text, style, anchor, h: PIXI.TextMetrics.measureText(item.text, style).height};
  });
  const contentHeight = placed.reduce((sum, item) => sum + item.h, 0) + (gap * Math.max(placed.length - 1, 0));
  let y = scrolling ? pad : pad + Math.max(0, (innerH - contentHeight) / 2);
  for ( const item of placed ) {
    item.x = item.texture ? pad + (anchor * (innerW - item.w)) : pad + (anchor * innerW);
    item.y = y;
    y += item.h + gap;
  }
  return {
    items: placed, width: W,
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
  const fontSize = Math.max(Math.min(size * scale, innerH / LINE_HEIGHT), MIN_FONT_SIZE);
  const style = textStyle(font, align, fontSize);
  const gap = fontSize * 2;
  const placed = [];
  let x = gap / 2;
  for ( const item of items ) {
    if ( item.texture ) {
      const h = Math.min(innerH, fontSize * LINE_HEIGHT * 2.5);
      const w = h * (item.texture.width / item.texture.height);
      placed.push({texture: item.texture, w, h, x, y: (H - h) / 2});
      x += w + gap;
      continue;
    }
    const text = item.text.split("\n").map(line => line.trim()).filter(Boolean).join("   •   ");
    const metrics = PIXI.TextMetrics.measureText(text, style);
    placed.push({text, style, anchor: 0, x, y: (H - metrics.height) / 2});
    x += metrics.width + gap;
  }
  return {items: placed, width: Math.max(W, x + (gap / 2)), height: H, pace: fontSize * SCROLL_LEFT};
}
