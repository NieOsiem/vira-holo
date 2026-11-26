const PADDING = 0.06;
const MAX_SIZE = 2048;
/** Texture pixels per scene pixel, a little above 1 so text stays crisp when zoomed in. */
const OVERSAMPLE = 1.25;
const MIN_FONT_SIZE = 6;
const LINE_HEIGHT = 1.2;
const ANCHORS = {left: 0, center: 0.5, right: 1};

/**
 * Renders a hologram's sign text, white on transparent, into a texture shaped like its panel.
 * The text is only re-rendered when its content, style or the panel size change.
 */
export default class TextPanel {
  texture = PIXI.RenderTexture.create({width: 2, height: 2});
  #key = "";

  /**
   * @param {{content: string, font: string, size: number, align: string}} text
   * @param {number} width    Panel width in scene pixels
   * @param {number} height   Panel height in scene pixels
   */
  async update(text, width, height) {
    const font = text.font || CONFIG.defaultFontFamily || "Signika";
    const scale = Math.min(OVERSAMPLE, MAX_SIZE / Math.max(width, height, 1));
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    const key = JSON.stringify([text.content, font, text.size, text.align, w, h]);
    if ( key === this.#key ) return;
    this.#key = key;
    try {
      await document.fonts.load(`32px "${font}"`);
    } catch(err) {
      console.warn(`Vira Holo | Could not load font "${font}"`, err);
    }
    if ( (key !== this.#key) || this.texture.destroyed ) return; // Superseded or destroyed while loading
    this.#render(text.content ?? "", font, text.size * scale, ANCHORS[text.align] ?? 0.5, text.align, w, h);
  }

  #render(content, fontFamily, fontSize, anchorX, align, w, h) {
    const renderer = canvas.app.renderer;
    if ( (this.texture.width !== w) || (this.texture.height !== h) ) this.texture.resize(w, h);
    if ( !content.trim() ) {
      renderer.render(new PIXI.Container(), {renderTexture: this.texture, clear: true});
      return;
    }

    const pad = Math.round(Math.min(w, h) * PADDING);
    const style = new PIXI.TextStyle({
      fontFamily, align, fill: "#ffffff",
      wordWrap: true, breakWords: true, wordWrapWidth: w - (2 * pad),
      dropShadow: true, dropShadowColor: "#ffffff", dropShadowAlpha: 0.5, dropShadowDistance: 0
    });
    const setSize = size => {
      style.fontSize = size;
      style.lineHeight = size * LINE_HEIGHT;
      style.dropShadowBlur = size * 0.25;
      style.padding = Math.ceil(size * 0.3);
    };
    setSize(Math.max(fontSize, MIN_FONT_SIZE));
    // Shrink text that doesn't fit the panel.
    while ( (style.fontSize > MIN_FONT_SIZE) && (PIXI.TextMetrics.measureText(content, style).height > h - (2 * pad)) ) {
      setSize(Math.max(style.fontSize * 0.9, MIN_FONT_SIZE));
    }

    const text = new PIXI.Text(content, style);
    text.resolution = 1;
    text.anchor.set(anchorX, 0.5);
    text.position.set(pad + (anchorX * (w - (2 * pad))), h / 2);
    renderer.render(text, {renderTexture: this.texture, clear: true});
    text.destroy(true);
  }

  destroy() {
    this.#key = "";
    this.texture.destroy(true);
  }
}
