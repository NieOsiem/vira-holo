import {MEASURE_INK} from "./data.mjs";

const INK = new PIXI.Color(MEASURE_INK).toNumber();
const LABEL_STYLE = {
  fontFamily: "monospace",
  fill: "#ffe9b0",
  fontWeight: "bold",
  letterSpacing: 1
};
/** Label font size in measurement size units at label size 1, and the smallest font (render-texture pixels). */
const LABEL_FONT = 0.8;
const MIN_FONT = 8;
/** Largest perspective scale a label is drawn at. */
const MAX_SCALE = 1.15;
/**
 * Where a measurement's label may sit, in order of preference: [how far from the middle of its line, in label heights
 * along it (never more than one), above (1) or below (-1) the line].
 */
const SPOTS = [[0, 1], [0, -1], [-1, 1], [1, 1], [-1, -1], [1, -1]];
/** Time constant of a label sliding along its line. */
const EASE_MS = 90;
/** How long the middle must stay free before a label slides back there. */
const SETTLE_MS = 400;
/** Gap kept between labels, in render-texture pixels. */
const MARGIN = 2;

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
    /** The spot (index into SPOTS) the label is given, since when the first has been free, and (eased) where it is. */
    this.spot = 0;
    this.firstFree = null;
    this.t = 0.5;
    this.side = SPOTS[0][1];
  }

  /** Redraw the label when its text, size or highlight changes. */
  draw(text, size, labelSize, selected, resolution) {
    const key = [text, size, labelSize, selected, resolution].join("|");
    if ( key === this.key ) return;
    this.key = key;
    // Text is a bitmap: render it at the hologram's resolution, and sharp enough to be scaled up by perspective.
    this.text.resolution = resolution * MAX_SCALE;
    const font = Math.max(MIN_FONT, Math.round(size * LABEL_FONT * labelSize));
    this.text.style.fontSize = font;
    this.text.text = text;
    const padX = font * 0.45;
    const padY = font * 0.2;
    const w = this.text.width + (padX * 2);
    const h = this.text.height + (padY * 2);
    this.box.clear()
      .lineStyle({width: Math.max(1, font * (selected ? 0.14 : 0.08)), color: INK, alpha: selected ? 1 : 0.65})
      .beginFill(0x140c06, 0.85)
      .drawRoundedRect(0, 0, w, h, font * 0.2)
      .endFill();
    this.text.position.set(padX, padY);
    this.labelSize = {w, h};
    this.size = size;
  }

  /**
   * @param {{x: number, y: number}} a       Endpoints, in render-texture pixels
   * @param {{x: number, y: number}} b
   * @param {{x: number, y: number, depth: number}} middle  Where the label is centred
   * @param {number} alpha
   * @param {number} scale   Perspective: how much bigger than usual the label is drawn
   */
  place(a, b, middle, alpha, scale) {
    const radius = Math.max(1.5, this.size * 0.28);
    this.dots.clear().beginFill(INK, 0.95).drawCircle(a.x, a.y, radius).drawCircle(b.x, b.y, radius).endFill();
    const {x, y, w, h} = this.labelRect(middle, this.side, scale);
    this.label.position.set(x, y);
    this.label.scale.set(scale);
    this.bounds = new PIXI.Rectangle(x, y, w, h);
    this.container.zIndex = -middle.depth;
    this.ends = [a, b];
    this.container.alpha = alpha;
    this.container.visible = alpha > 0.01;
  }

  /** The label's box when it sits above (side 1) or below (-1) a point of the line: {x, y, w, h}. */
  labelRect(point, side, scale) {
    const w = this.labelSize.w * scale;
    const h = this.labelSize.h * scale;
    const gap = this.size * 0.4 * scale;
    const above = point.y - h - gap;
    const below = point.y + gap;
    return {x: point.x - (w / 2), y: below + ((above - below) * ((side + 1) / 2)), w, h};
  }

  destroy() {
    this.container.destroy({children: true});
  }
}

/** Endpoints and labels of every measurement on a hologram, drawn into its render texture. */
export default class MeasureLayer {
  /** @type {Map<string, MeasureSprite>} */
  #sprites = new Map();
  #last = null;

  /** @param {PIXI.Container} parent   Where the labels go: drawn far to near with the pins (by zIndex) */
  constructor(parent) {
    this.parent = parent;
  }

  /**
   * Create and remove sprites to match the measurements and update their labels.
   * @param {{id: string, text: string}[]} labels
   * @param {number} size
   * @param {number} labelSize    Label size setting
   * @param {string|null} selected
   * @param {number} [resolution=1]   Device pixels per layout pixel
   * @returns {Map<string, MeasureSprite>}
   */
  sync(labels, size, labelSize, selected, resolution=1) {
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
        this.parent.addChild(sprite.container);
      }
      sprite.draw(text, size, labelSize, id === selected, resolution);
    }
    return this.#sprites;
  }

  /** @returns {MeasureSprite|undefined} */
  get(id) {
    return this.#sprites.get(id);
  }

  /**
   * Place the labels for this frame. Each in turn (the selected one, then nearest first) keeps its spot while that's
   * clear of what was placed before it, else moves to the first clear spot (SPOTS), or the least covered one if none
   * is; and back to the first spot once that has been clear a while.
   * @param {object[]} items   {id, a, b, at}: projected ends (null behind the camera), and at(t) → {point, scale,
   *                           alpha} for the point a fraction t along the line (null behind the camera)
   * @param {{x: number, y: number, w: number, h: number}[]} obstacles   Boxes to keep clear of (labels that stay
   *                           put, pin heads)
   * @param {string|null} selected
   */
  layout(items, obstacles, selected) {
    const now = performance.now();
    const ease = 1 - Math.exp(-Math.clamp(now - (this.#last ?? now), 0, 100) / EASE_MS);
    this.#last = now;
    const taken = [...obstacles];
    const placed = items.map(item => ({...item, middle: item.at(0.5)}));
    placed.sort((p, q) => (Number(q.id === selected) - Number(p.id === selected))
      || ((p.middle?.point.depth ?? 0) - (q.middle?.point.depth ?? 0)));
    for ( const {id, a, b, at, middle} of placed ) {
      const sprite = this.#sprites.get(id);
      // A label height as a fraction of the line's length on screen.
      const length = (a && b) ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
      const step = (middle && (length > 1)) ? (sprite.labelSize.h * middle.scale) / length : 0;
      const ts = SPOTS.map(([along]) => Math.clamp(0.5 + (along * step), 0, 1));
      const boxes = ts.map((t, i) => {
        const spot = at(t);
        return spot && sprite.labelRect(spot.point, SPOTS[i][1], spot.scale);
      });
      const covered = i => (boxes[i] ? taken.reduce((sum, box) => sum + overlap(boxes[i], box), 0) : Infinity);
      const free = i => covered(i) === 0;
      if ( !free(sprite.spot) ) {
        const index = boxes.findIndex((_, i) => free(i));
        if ( index >= 0 ) sprite.spot = index;
        else {
          // Nowhere clear: the least covered spot, staying put unless another is clearly better.
          const cover = boxes.map((_, i) => covered(i));
          const least = cover.indexOf(Math.min(...cover));
          if ( cover[least] < cover[sprite.spot] * 0.7 ) sprite.spot = least;
        }
      }
      else if ( (sprite.spot !== 0) && free(0) ) {
        sprite.firstFree ??= now;
        if ( now - sprite.firstFree >= SETTLE_MS ) sprite.spot = 0;
      }
      if ( (sprite.spot === 0) || !free(0) ) sprite.firstFree = null;
      if ( boxes[sprite.spot] ) taken.push(boxes[sprite.spot]);
      sprite.t += (ts[sprite.spot] - sprite.t) * ease;
      sprite.side += (SPOTS[sprite.spot][1] - sprite.side) * ease;
      const shown = at(sprite.t);
      if ( !a || !b || !shown ) {
        sprite.container.visible = false;
        continue;
      }
      sprite.place(a, b, shown.point, shown.alpha, shown.scale);
    }
  }

  /** The boxes of the labels on show: {x, y, w, h}. */
  get boxes() {
    return Array.from(this.#sprites.values()).filter(s => s.container.visible && s.bounds)
      .map(({bounds: {x, y, width, height}}) => ({x, y, w: width, h: height}));
  }

  /**
   * The measurement whose label is under a render-texture point (the front-most where labels overlap).
   * @returns {string|null}
   */
  hitTest(x, y) {
    let best = null;
    for ( const [id, sprite] of this.#sprites ) {
      if ( !sprite.container.visible || !sprite.bounds?.contains(x, y) ) continue;
      if ( !best || (sprite.container.zIndex > best.z) ) best = {id, z: sprite.container.zIndex};
    }
    return best?.id ?? null;
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
  }
}

/** How much of two boxes {x, y, w, h} overlaps, each grown by MARGIN (0 if they're clear of each other). */
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + MARGIN;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + MARGIN;
  return ((w > 0) && (h > 0)) ? w * h : 0;
}
