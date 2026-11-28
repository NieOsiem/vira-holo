import {MEASURE_INK} from "./data.mjs";
import {centredTextY, outlineWidth, setLabelText} from "./label-style.mjs";

const INK = new PIXI.Color(MEASURE_INK).toNumber();
/** The label text's colour and weight; its font, size and spacing come from the look (see label-style.mjs). */
const LABEL_STYLE = {fill: "#ffe9b0", fontWeight: "bold"};
/** Label font size in measurement size units at label size 1, and the smallest font (render-texture pixels). */
const LABEL_FONT = 0.8;
const MIN_FONT = 1;
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
/** zIndex of a hovered or selected measurement, above everything else drawn far to near. */
const FOCUS_Z = 1e6;

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
    /** The label's eased alpha: hidden labels fade in while their measurement is hovered or selected. */
    this.labelAlpha = 1;
  }

  /** Redraw the label when its text, size or highlight changes. */
  draw(text, size, style, selected, resolution) {
    const key = [text, size, JSON.stringify(style), selected, resolution].join("|");
    if ( key === this.key ) return;
    this.key = key;
    // Text is a bitmap: render it at the hologram's resolution, and sharp enough to be scaled up by perspective.
    this.text.resolution = resolution * MAX_SCALE;
    const font = Math.max(MIN_FONT, Math.round(size * LABEL_FONT * style.size * 10) / 10);
    setLabelText(this.text, text, font, style);
    const padX = font * 0.45;
    const padY = font * 0.2;
    const w = this.text.width + (padX * 2);
    const h = this.text.height + (padY * 2);
    this.box.clear()
      .lineStyle({width: outlineWidth(font, selected ? 0.14 : 0.08, style, resolution, selected), color: INK,
        alpha: selected ? 1 : 0.65})
      .beginFill(0x140c06, 0.85)
      .drawRoundedRect(0, 0, w, h, font * 0.2)
      .endFill();
    this.text.position.set(padX, centredTextY(this.text, h));
    this.labelSize = {w, h};
    this.size = size;
  }

  /**
   * @param {{x: number, y: number}} a       Endpoints, in render-texture pixels
   * @param {{x: number, y: number}} b
   * @param {{x: number, y: number, depth: number}} middle  Where the label is centred
   * @param {number} alpha
   * @param {number} scale   Perspective: how much bigger than usual the label is drawn
   * @param {boolean} focused   Hovered or selected: drawn on top
   */
  place(a, b, middle, alpha, scale, focused) {
    const radius = Math.max(1.5, this.size * 0.28);
    this.dots.clear().beginFill(INK, 0.95).drawCircle(a.x, a.y, radius).drawCircle(b.x, b.y, radius).endFill();
    const {x, y, w, h} = this.labelRect(middle, this.side, scale);
    this.label.position.set(x, y);
    this.label.scale.set(scale);
    this.bounds = new PIXI.Rectangle(x, y, w, h);
    this.label.alpha = this.labelAlpha;
    this.label.visible = this.labelAlpha > 0.01;
    this.container.zIndex = focused ? FOCUS_Z : -middle.depth;
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
   * @param {object} style    How labels are drawn (see labelStyle)
   * @param {string|null} selected
   * @param {number} [resolution=1]   Device pixels per layout pixel
   * @returns {Map<string, MeasureSprite>}
   */
  sync(labels, size, style, selected, resolution=1) {
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
      sprite.draw(text, size, style, id === selected, resolution);
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
   * @param {object} options
   * @param {string|null} options.selected
   * @param {"fresh"|"hold"|"follow"} options.mode   Lay out afresh: the first clear spot, at once; not at all; or
   *                           keeping spots (see HoloRenderer#layoutMode)
   * @param {boolean} options.labels   Whether the labels are shown (else only while hovered or selected)
   * @param {string[]} options.focus   The hovered or selected measurements
   */
  layout(items, obstacles, {selected, mode, labels, focus}) {
    const fresh = mode === "fresh";
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
      if ( labels && (mode !== "hold") ) this.#choose(sprite, boxes, taken, fresh, now);
      // A label shown only while hovered takes no room from the others.
      sprite.target = labels ? boxes[sprite.spot] : null;
      if ( sprite.target ) taken.push(sprite.target);
      const focused = focus.includes(id);
      sprite.labelAlpha += (((labels || focused) ? 1 : 0) - sprite.labelAlpha) * ease;
      sprite.t += (ts[sprite.spot] - sprite.t) * ease;
      sprite.side += (SPOTS[sprite.spot][1] - sprite.side) * ease;
      const shown = at(sprite.t);
      if ( !a || !b || !shown ) {
        sprite.container.visible = false;
        continue;
      }
      sprite.place(a, b, shown.point, shown.alpha, shown.scale, focused);
    }
  }

  /**
   * Pick a label's spot among its boxes (one per SPOTS; null behind the camera), given what's taken: keep it while
   * it's clear, else the first clear one, else the least covered (unless that's hardly better); back to the first
   * once that has been clear for SETTLE_MS. Afresh, simply the first clear one, else the least covered.
   */
  #choose(sprite, boxes, taken, fresh, now) {
    const covered = i => (boxes[i] ? taken.reduce((sum, box) => sum + overlap(boxes[i], box), 0) : Infinity);
    const free = i => covered(i) === 0;
    if ( fresh ) sprite.spot = 0;
    if ( !free(sprite.spot) ) {
      const index = boxes.findIndex((_, i) => free(i));
      if ( index >= 0 ) sprite.spot = index;
      else {
        const cover = boxes.map((_, i) => covered(i));
        const least = cover.indexOf(Math.min(...cover));
        if ( fresh || (cover[least] < cover[sprite.spot] * 0.7) ) sprite.spot = least;
      }
    }
    else if ( (sprite.spot !== 0) && free(0) ) {
      sprite.firstFree ??= now;
      if ( now - sprite.firstFree >= SETTLE_MS ) sprite.spot = 0;
    }
    if ( (sprite.spot === 0) || !free(0) ) sprite.firstFree = null;
  }

  /** Where the labels on show are going: {x, y, w, h}. */
  get boxes() {
    return Array.from(this.#sprites.values()).filter(s => s.container.visible && s.target).map(s => s.target);
  }

  /**
   * The measurement whose label is under a render-texture point (the front-most where labels overlap).
   * @returns {string|null}
   */
  hitTest(x, y) {
    let best = null;
    for ( const [id, sprite] of this.#sprites ) {
      if ( !sprite.container.visible || (sprite.labelAlpha < 0.5) || !sprite.bounds?.contains(x, y) ) continue;
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
