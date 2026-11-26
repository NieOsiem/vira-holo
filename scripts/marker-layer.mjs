import {MARKER_SIZES} from "./data.mjs";

/** Glyph outlines as points on a unit circle; circle is drawn as a circle. */
const GLYPH_SHAPES = {
  diamond: [0, -1, 1, 0, 0, 1, -1, 0],
  triangle: [0, -1, 0.95, 0.75, -0.95, 0.75],
  square: [-0.78, -0.78, 0.78, -0.78, 0.78, 0.78, -0.78, 0.78]
};
const LABEL_STYLE = {
  fontFamily: "monospace",
  fill: "#fff3d6",
  fontWeight: "bold",
  letterSpacing: 1
};

/** One waypoint: a stem from the surface, a ground ring, a glyph head and an optional label. */
class MarkerSprite {
  constructor() {
    this.container = new PIXI.Container();
    this.stem = new PIXI.Graphics();
    this.ground = new PIXI.Graphics();
    this.head = new PIXI.Graphics();
    this.label = new PIXI.Container();
    this.labelBox = new PIXI.Graphics();
    this.text = new PIXI.Text("", LABEL_STYLE);
    this.text.resolution = 1;
    this.label.addChild(this.labelBox, this.text);
    this.container.addChild(this.ground, this.stem, this.head, this.label);
    this.key = "";
  }

  /** Redraw the parts that only change with the waypoint's settings or the hologram's size. */
  draw(marker, size, showLabel, selected) {
    const key = [marker.label, marker.glyph, marker.color, size, showLabel, selected].join("|");
    if ( key === this.key ) return;
    this.key = key;
    const color = new PIXI.Color(marker.color).toNumber();
    const radius = size * (selected ? 1.35 : 1);

    this.head.clear();
    const shape = GLYPH_SHAPES[marker.glyph];
    const outline = (width, alpha, fill) => {
      this.head.lineStyle({width, color, alpha, join: PIXI.LINE_JOIN.ROUND});
      if ( fill ) this.head.beginFill(color, fill);
      if ( shape ) this.head.drawPolygon(shape.map(p => p * radius));
      else this.head.drawCircle(0, 0, radius * 0.85);
      if ( fill ) this.head.endFill();
    };
    outline(radius * 0.9, 0.18); // glow
    outline(Math.max(1, radius * 0.22), 1, selected ? 0.75 : 0.45);

    const visible = showLabel && !!marker.label;
    this.label.visible = visible;
    if ( visible ) {
      this.text.style.fontSize = Math.round(size * 1.5);
      this.text.text = marker.label.toUpperCase();
      const padX = size * 0.6;
      const padY = size * 0.3;
      const w = this.text.width + (padX * 2);
      const h = this.text.height + (padY * 2);
      this.labelBox.clear()
        .lineStyle({width: Math.max(1, size * 0.12), color, alpha: 0.8})
        .beginFill(0x08050a, 0.72)
        .drawRoundedRect(0, 0, w, h, size * 0.3)
        .endFill();
      this.text.position.set(padX, padY);
      this.labelSize = {w, h};
    }
    this.color = color;
    this.size = size;
  }

  /**
   * Place the waypoint between its surface point and its head (render-texture pixels).
   * @param {{x: number, y: number}} base
   * @param {{x: number, y: number}} head
   * @param {number} groundSquash   How flat the ground ring looks (sine of the camera pitch)
   * @param {number} alpha
   */
  place(base, head, groundSquash, alpha) {
    const {color, size} = this;
    this.stem.clear()
      .lineStyle({width: size * 0.6, color, alpha: 0.15})
      .moveTo(base.x, base.y).lineTo(head.x, head.y)
      .lineStyle({width: Math.max(1, size * 0.16), color, alpha: 0.9})
      .moveTo(base.x, base.y).lineTo(head.x, head.y);
    this.ground.clear()
      .lineStyle({width: Math.max(1, size * 0.14), color, alpha: 0.8})
      .drawEllipse(base.x, base.y, size * 0.9, size * 0.9 * Math.max(groundSquash, 0.15));
    this.head.position.set(head.x, head.y);
    if ( this.label.visible ) this.label.position.set(head.x + (size * 1.6), head.y - (this.labelSize.h / 2));
    this.container.alpha = alpha;
    this.container.visible = alpha > 0.01;
    this.base = base;
    this.tip = head;
  }

  destroy() {
    this.container.destroy({children: true});
  }
}

/** All waypoints of one hologram, drawn into its render texture above the content. */
export default class MarkerLayer {
  container = new PIXI.Container();
  /** @type {Map<string, MarkerSprite>} */
  #sprites = new Map();

  /**
   * Create, update and remove sprites to match the waypoints.
   * @param {object[]} markers
   * @param {{size: number, labels: boolean, selected: string|null}} options
   */
  sync(markers, {size, labels, selected}) {
    const ids = new Set(markers.map(m => m.id));
    for ( const [id, sprite] of this.#sprites ) {
      if ( ids.has(id) ) continue;
      sprite.destroy();
      this.#sprites.delete(id);
    }
    for ( const marker of markers ) {
      let sprite = this.#sprites.get(marker.id);
      if ( !sprite ) {
        sprite = new MarkerSprite();
        this.#sprites.set(marker.id, sprite);
        this.container.addChild(sprite.container);
      }
      sprite.draw(marker, size * (MARKER_SIZES[marker.size] ?? 1), labels, marker.id === selected);
    }
  }

  /** @returns {MarkerSprite|undefined} */
  get(id) {
    return this.#sprites.get(id);
  }

  /**
   * The waypoint whose head or base is closest to a render-texture point, within reach.
   * @param {number} x
   * @param {number} y
   * @returns {string|null}
   */
  hitTest(x, y) {
    let best = null;
    let bestDistance = Infinity;
    for ( const [id, sprite] of this.#sprites ) {
      if ( !sprite.container.visible || !sprite.tip ) continue;
      const reach = sprite.size * 1.8;
      const distance = Math.min(Math.hypot(x - sprite.tip.x, y - sprite.tip.y), Math.hypot(x - sprite.base.x, y - sprite.base.y));
      if ( (distance <= reach) && (distance < bestDistance) ) {
        best = id;
        bestDistance = distance;
      }
    }
    return best;
  }

  destroy() {
    for ( const sprite of this.#sprites.values() ) sprite.destroy();
    this.#sprites.clear();
    this.container.destroy({children: true});
  }
}
