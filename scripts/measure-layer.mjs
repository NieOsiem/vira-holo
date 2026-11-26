import {MEASURE_INK} from "./data.mjs";

const INK = new PIXI.Color(MEASURE_INK).toNumber();
const LABEL_STYLE = {
  fontFamily: "monospace",
  fill: "#ffe9b0",
  fontWeight: "bold",
  letterSpacing: 1
};

/** One measurement's endpoint dots and distance label; its line is drawn by a StrokeLayer. */
class MeasureSprite {
  constructor() {
    this.container = new PIXI.Container();
    this.dots = new PIXI.Graphics();
    this.label = new PIXI.Container();
    this.box = new PIXI.Graphics();
    this.text = new PIXI.Text("", LABEL_STYLE);
    this.text.resolution = 1;
    this.label.addChild(this.box, this.text);
    this.container.addChild(this.dots, this.label);
    this.key = "";
  }

  /** Redraw the label when its text, size or highlight changes. */
  draw(text, size, selected) {
    const key = [text, size, selected].join("|");
    if ( key === this.key ) return;
    this.key = key;
    this.text.style.fontSize = Math.round(size * 1.3);
    this.text.text = text;
    const padX = size * 0.6;
    const padY = size * 0.25;
    const w = this.text.width + (padX * 2);
    const h = this.text.height + (padY * 2);
    this.box.clear()
      .lineStyle({width: Math.max(1, size * (selected ? 0.18 : 0.1)), color: INK, alpha: selected ? 1 : 0.65})
      .beginFill(0x140c06, 0.85)
      .drawRoundedRect(0, 0, w, h, size * 0.25)
      .endFill();
    this.text.position.set(padX, padY);
    this.labelSize = {w, h};
    this.size = size;
  }

  /**
   * @param {{x: number, y: number}} a       Endpoints, in render-texture pixels
   * @param {{x: number, y: number}} b
   * @param {{x: number, y: number}} middle  Where the label is centred
   * @param {number} alpha
   */
  place(a, b, middle, alpha) {
    const radius = Math.max(1.5, this.size * 0.28);
    this.dots.clear().beginFill(INK, 0.95).drawCircle(a.x, a.y, radius).drawCircle(b.x, b.y, radius).endFill();
    const {w, h} = this.labelSize;
    this.label.position.set(middle.x - (w / 2), middle.y - h - (this.size * 0.6));
    this.bounds = new PIXI.Rectangle(this.label.x, this.label.y, w, h);
    this.ends = [a, b];
    this.container.alpha = alpha;
    this.container.visible = alpha > 0.01;
  }

  destroy() {
    this.container.destroy({children: true});
  }
}

/** Endpoints and labels of every measurement on a hologram, drawn into its render texture. */
export default class MeasureLayer {
  container = new PIXI.Container();
  /** @type {Map<string, MeasureSprite>} */
  #sprites = new Map();

  /**
   * Create and remove sprites to match the measurements and update their labels.
   * @param {{id: string, text: string}[]} labels
   * @param {number} size
   * @param {string|null} selected
   * @returns {Map<string, MeasureSprite>}
   */
  sync(labels, size, selected) {
    const ids = new Set(labels.map(l => l.id));
    for ( const [id, sprite] of this.#sprites ) {
      if ( ids.has(id) ) continue;
      sprite.destroy();
      this.#sprites.delete(id);
    }
    for ( const {id, text} of labels ) {
      let sprite = this.#sprites.get(id);
      if ( !sprite ) {
        sprite = new MeasureSprite();
        this.#sprites.set(id, sprite);
        this.container.addChild(sprite.container);
      }
      sprite.draw(text, size, id === selected);
    }
    return this.#sprites;
  }

  /** @returns {MeasureSprite|undefined} */
  get(id) {
    return this.#sprites.get(id);
  }

  /**
   * The measurement whose label is under a render-texture point.
   * @returns {string|null}
   */
  hitTest(x, y) {
    for ( const [id, sprite] of this.#sprites ) {
      if ( sprite.container.visible && sprite.bounds?.contains(x, y) ) return id;
    }
    return null;
  }

  /**
   * The measurement end whose dot is nearest a render-texture point, within grabbing reach.
   * @returns {{id: string, end: 0|1}|null}
   */
  endAt(x, y) {
    let best = null;
    let bestDistance = Infinity;
    for ( const [id, sprite] of this.#sprites ) {
      if ( !sprite.container.visible || !sprite.ends ) continue;
      sprite.ends.forEach((point, end) => {
        const distance = Math.hypot(x - point.x, y - point.y);
        if ( (distance <= sprite.size * 1.4) && (distance < bestDistance) ) {
          best = {id, end};
          bestDistance = distance;
        }
      });
    }
    return best;
  }

  destroy() {
    for ( const sprite of this.#sprites.values() ) sprite.destroy();
    this.#sprites.clear();
    this.container.destroy({children: true});
  }
}
