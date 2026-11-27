/** Longer side of the overlay texture areas are drawn into, in texels. */
const OVERLAY_SIZE = 1024;
const LABEL_STYLE = {fontFamily: "monospace", fill: "#ffffff", fontWeight: "bold", letterSpacing: 1};

/** One area's label: its name (or size), in a box edged with its ink. Clicking it opens the area's card. */
class AreaLabel {
  constructor() {
    this.container = new PIXI.Container();
    this.box = new PIXI.Graphics();
    this.text = new PIXI.Text("", LABEL_STYLE);
    this.container.addChild(this.box, this.text);
    this.key = "";
  }

  draw(text, color, size, selected, resolution) {
    const key = [text, color, size, selected, resolution].join("|");
    if ( key === this.key ) return;
    this.key = key;
    const ink = new PIXI.Color(color);
    this.text.resolution = resolution; // Text is a bitmap: render it at the hologram's resolution
    this.text.style.fontSize = Math.round(size * 1.2);
    const [r, g, b] = ink.toRgbArray();
    this.text.style.fill = new PIXI.Color([(r + 1) / 2, (g + 1) / 2, (b + 1) / 2]).toHex(); // Ink, lightened to read
    this.text.text = text;
    const padX = size * 0.55;
    const padY = size * 0.2;
    const w = this.text.width + (padX * 2);
    const h = this.text.height + (padY * 2);
    this.box.clear()
      .lineStyle({width: Math.max(1, size * (selected ? 0.18 : 0.09)), color: ink.toNumber(), alpha: selected ? 1 : 0.7})
      .beginFill(0x0a0806, 0.75)
      .drawRoundedRect(0, 0, w, h, size * 0.3)
      .endFill();
    this.text.position.set(padX, padY);
    this.size = {w, h};
  }

  /** Centre the label on a render-texture point. */
  place({x, y}, alpha) {
    const {w, h} = this.size;
    this.container.position.set(x - (w / 2), y - (h / 2));
    this.bounds = new PIXI.Rectangle(this.container.x, this.container.y, w, h);
    this.container.alpha = alpha;
    this.container.visible = alpha > 0.01;
  }

  destroy() {
    this.container.destroy({children: true});
  }
}

/**
 * A hologram's areas: their fills and outlines drawn into a texture laid over the image (so the panel and terrain
 * shaders put them exactly on the surface, relief included), and their labels drawn into the render texture.
 */
export default class AreaLayer {
  /** The overlay, in image UV: premultiplied colour to add to the surface. */
  overlay = PIXI.RenderTexture.create({width: 2, height: 2});
  labels = new PIXI.Container();
  #graphics = new PIXI.Graphics();
  #key = null;
  /** @type {Map<string, AreaLabel>} */
  #sprites = new Map();

  /**
   * Redraw the overlay when the areas or the image's shape changed.
   * @param {PIXI.Renderer} renderer
   * @param {{id: string, color: string, outline: number[], closed: boolean, selected: boolean}[]} areas
   *   Outlines are [u, v, ...]; an open outline is an area still being drawn
   * @param {number} aspect   Image width over height
   */
  drawOverlay(renderer, areas, aspect) {
    const width = Math.max(2, Math.round((aspect >= 1) ? OVERLAY_SIZE : OVERLAY_SIZE * aspect));
    const height = Math.max(2, Math.round((aspect >= 1) ? OVERLAY_SIZE / aspect : OVERLAY_SIZE));
    const key = JSON.stringify([width, height, areas]);
    if ( key === this.#key ) return;
    this.#key = key;
    if ( (this.overlay.width !== width) || (this.overlay.height !== height) ) this.overlay.resize(width, height);
    const g = this.#graphics.clear();
    const line = OVERLAY_SIZE * 0.0035;
    for ( const {color, outline, closed, selected} of areas ) {
      const ink = new PIXI.Color(color).toNumber();
      const points = [];
      for ( let i = 0; i < outline.length; i += 2 ) points.push(outline[i] * width, outline[i + 1] * height);
      if ( closed && (points.length >= 6) ) {
        g.lineStyle(0).beginFill(ink, selected ? 0.3 : 0.2).drawPolygon(points).endFill();
        // A soft band along the edge, then the edge itself.
        g.lineStyle({width: line * 4, color: ink, alpha: 0.18, join: PIXI.LINE_JOIN.ROUND}).drawPolygon(points);
        g.lineStyle({width: line * (selected ? 1.8 : 1), color: ink, alpha: 0.95, join: PIXI.LINE_JOIN.ROUND}).drawPolygon(points);
        continue;
      }
      // Still being drawn: the edges so far (and to the pointer), and its corners.
      g.lineStyle({width: line, color: ink, alpha: 0.95, join: PIXI.LINE_JOIN.ROUND, cap: PIXI.LINE_CAP.ROUND});
      g.moveTo(points[0], points[1]);
      for ( let i = 2; i < points.length; i += 2 ) g.lineTo(points[i], points[i + 1]);
      g.lineStyle(0).beginFill(ink, 1);
      for ( let i = 0; i < points.length; i += 2 ) g.drawCircle(points[i], points[i + 1], line * 1.6);
      g.endFill();
    }
    renderer.render(g, {renderTexture: this.overlay, clear: true});
  }

  /**
   * Create and remove labels to match the areas.
   * @param {{id: string, text: string, color: string}[]} labels
   * @returns {Map<string, AreaLabel>}
   */
  sync(labels, size, selected, resolution=1) {
    const ids = new Set(labels.map(l => l.id));
    for ( const [id, sprite] of this.#sprites ) {
      if ( ids.has(id) ) continue;
      sprite.destroy();
      this.#sprites.delete(id);
    }
    for ( const {id, text, color} of labels ) {
      let sprite = this.#sprites.get(id);
      if ( !sprite ) {
        sprite = new AreaLabel();
        this.#sprites.set(id, sprite);
        this.labels.addChild(sprite.container);
      }
      sprite.draw(text, color, size, id === selected, resolution);
    }
    return this.#sprites;
  }

  /** The area whose label is under a render-texture point. */
  hitTest(x, y) {
    for ( const [id, sprite] of this.#sprites ) {
      if ( sprite.container.visible && sprite.bounds?.contains(x, y) ) return id;
    }
    return null;
  }

  /** @returns {AreaLabel|undefined} */
  get(id) {
    return this.#sprites.get(id);
  }

  destroy() {
    for ( const sprite of this.#sprites.values() ) sprite.destroy();
    this.#sprites.clear();
    this.labels.destroy({children: true});
    this.#graphics.destroy();
    this.overlay.destroy(true);
  }
}
