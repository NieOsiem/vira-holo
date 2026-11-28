import {IMAGE_GLYPH, MARKER_SIZES} from "./data.mjs";
import {centredTextY, outlineWidth, setLabelText} from "./label-style.mjs";

/** Glyph outlines as points on a unit circle; circle is drawn as a circle. */
const GLYPH_SHAPES = {
  diamond: [0, -1, 1, 0, 0, 1, -1, 0],
  triangle: [0, -1, 0.95, 0.75, -0.95, 0.75],
  square: [-0.78, -0.78, 0.78, -0.78, 0.78, 0.78, -0.78, 0.78]
};
/** The label text's colour and weight; its font, size and spacing come from the look (see label-style.mjs). */
const LABEL_STYLE = {fill: "#fff3d6", fontWeight: "bold"};
/** Label font size in pin size units at label size 1. */
const LABEL_FONT = 0.9;
/**
 * Smallest label font, in render-texture pixels: only a guard against degenerate text. Text is drawn at the hologram's
 * resolution, so a small tile's tiny labels stay sharp; a bigger floor would stop the label size going down there.
 */
const MIN_FONT = 1;
/** Label scale per size tier: gentler than the glyph's (MARKER_SIZES), so small pins' labels stay readable. */
const LABEL_TIERS = {0: 0.65, 1: 0.75, 2: 0.87, 3: 1};
/**
 * Places a pin's label may take, in order of preference: [rise, lean, side]. The label sits right (side 1) or left
 * (-1) of the head. The head may rise (its stem grows) and, when nothing upright is free, lean towards the label's
 * side, both in icon sizes and never further than one icon size from where it stands. Upright places come first:
 * the first UPRIGHT of them.
 */
const PLACES = [];
for ( const lean of [0, 0.5, 1] ) {
  for ( const rise of [0, 0.5, 1] ) {
    if ( Math.hypot(rise, lean) > 1 ) continue;
    for ( const side of [1, -1] ) PLACES.push([rise, lean, side]);
  }
}
const UPRIGHT = 6;
/** Largest perspective scale a pin is drawn at (see HoloRenderer#layoutMarkers). */
export const MAX_SCALE = 1.15;
/** Time constant of pins rising, leaning and labels fading or changing sides. */
const EASE_MS = 90;
/** How long any place must stay free before a hidden label shows there. */
const SETTLE_MS = 400;
/** How long a place earlier in PLACES must stay free before a label moves there from one that's still free. */
const BETTER_MS = 1000;
/** How much of a label's place may get covered before it moves, as a fraction of its area. */
const TOLERANCE = 0.2;
/** Gap kept between labels, and between labels and pin heads, in render-texture pixels. */
const MARGIN = 2;
/** zIndex of a hovered or selected pin, above everything else drawn far to near. */
const FOCUS_Z = 1e6;
/** Halo textures: the picture's longer side in them, the room around it, and how much of it the blur spreads over. */
const HALO_ICON = 128;
const HALO_PAD = 80;
const HALO_BLUR = 36;
/** Halo alpha, like the built-in glyphs' glow (stronger when selected). */
const HALO_ALPHA = 0.22;
/** Dark shadow colour (matches label boxes) and image-pin shadow silhouette parameters (tighter than the glow halo). */
const SHADOW_COLOR = 0x060408;
const SHADOW_PAD = 40;
const SHADOW_BLUR = 11;
/**
 * An image pin's stem fades out into its picture, which it would otherwise cross: from this far from the head's centre
 * to this far, in head radii (the picture's half extent), in this many steps.
 */
const STEM_FADE = [1.5, 0.45];
const STEM_FADE_STEPS = 8;
/** @type {Map<string, PIXI.RenderTexture>} Each pin image's halo (white; tinted per pin), made once. */
const halos = new Map();
/** @type {Map<string, PIXI.RenderTexture>} Each pin image's tight dark shadow silhouette, made once. */
const shadows = new Map();

/**
 * A pin image's halo: its silhouette, grown and softened, in white. Made once per image (and kept: it's small), so
 * pins draw it as a plain sprite rather than blurring every frame.
 * @param {PIXI.Texture} texture
 * @param {string} src
 */
function haloOf(texture, src) {
  let halo = halos.get(src);
  if ( halo ) return halo;
  const size = HALO_ICON + (2 * HALO_PAD);
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.position.set(size / 2, size / 2);
  sprite.scale.set(HALO_ICON / Math.max(texture.width, texture.height, 1));
  // Blur the silhouette, then turn it white and boost its alpha, so the halo is a solid band that fades at its edge.
  const blur = new PIXI.BlurFilter(HALO_BLUR, 4);
  const whiten = new PIXI.ColorMatrixFilter();
  whiten.matrix = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 6, 0];
  sprite.filters = [blur, whiten];
  sprite.filterArea = new PIXI.Rectangle(0, 0, size, size);
  halo = PIXI.RenderTexture.create({width: size, height: size});
  canvas.app.renderer.render(sprite, {renderTexture: halo, clear: true});
  sprite.filters = null;
  sprite.destroy();
  blur.destroy();
  whiten.destroy();
  halos.set(src, halo);
  return halo;
}

/**
 * A pin image's soft dark shadow: a tighter silhouette than the halo, in near-black, made once per image. Sits right
 * behind the picture so overlapping same-colour icons and interior cutouts separate cleanly.
 * @param {PIXI.Texture} texture
 * @param {string} src
 */
function shadowOf(texture, src) {
  let shadow = shadows.get(src);
  if ( shadow ) return shadow;
  const size = HALO_ICON + (2 * SHADOW_PAD);
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.position.set(size / 2, size / 2);
  sprite.scale.set(HALO_ICON / Math.max(texture.width, texture.height, 1));
  const blur = new PIXI.BlurFilter(SHADOW_BLUR, 4);
  const darken = new PIXI.ColorMatrixFilter();
  darken.matrix = [0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0.015, 0, 0, 0, 0, 0.03, 0, 0, 0, 4.5, 0];
  sprite.filters = [blur, darken];
  sprite.filterArea = new PIXI.Rectangle(0, 0, size, size);
  shadow = PIXI.RenderTexture.create({width: size, height: size});
  canvas.app.renderer.render(sprite, {renderTexture: shadow, clear: true});
  sprite.filters = null;
  sprite.destroy();
  blur.destroy();
  darken.destroy();
  shadows.set(src, shadow);
  return shadow;
}

/** One waypoint: a stem from the surface, a ground ring, a glyph head and an optional label. */
class MarkerSprite {
  constructor() {
    this.container = new PIXI.Container();
    this.stem = new PIXI.Graphics();
    this.ground = new PIXI.Graphics();
    this.head = new PIXI.Graphics();
    /** An image glyph's picture, on the head (so it moves and scales with it); its texture is Foundry's cache's. */
    this.icon = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.icon.anchor.set(0.5);
    this.icon.visible = false;
    this.iconSrc = null;
    /** Its halo and dark shadow, behind it (see haloOf, shadowOf). */
    this.halo = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.halo.anchor.set(0.5);
    this.halo.visible = false;
    this.shadowSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.shadowSprite.anchor.set(0.5);
    this.shadowSprite.visible = false;
    this.head.addChild(this.halo, this.shadowSprite, this.icon);
    this.label = new PIXI.Container();
    this.labelBox = new PIXI.Graphics();
    this.text = new PIXI.Text("", LABEL_STYLE);
    this.text.resolution = 1;
    this.label.addChild(this.labelBox, this.text);
    this.container.addChild(this.ground, this.stem, this.head, this.label);
    this.key = "";
    this.hasLabel = false;
    /** When the label shows (LABEL_SHOWS). */
    this.labelShow = "auto";
    /** Layout: the place (index into PLACES) the label is given, and whether it's shown at all. */
    this.place = 0;
    this.shown = false;
    /** The label's box as last laid out (null while hidden). */
    this.box = null;
    /** A better place that's free, and since when: {index, since}. */
    this.better = null;
    /** Since when a place has been free for the hidden label. */
    this.freeSince = null;
    /** Eased towards the layout: how far the head is moved (pixels), the label's side (-1..1) and its alpha. */
    this.dx = 0;
    this.dy = 0;
    this.side = 1;
    this.labelAlpha = 0;
  }

  /** Redraw the parts that only change with the waypoint's settings or the hologram's size. */
  draw(marker, unit, pinSize, pinShadow, style, selected, resolution) {
    this.labelShow = marker.labelShow ?? "auto";
    const key = [marker.label, marker.glyph, marker.color, marker.size, marker.image, marker.tint, unit, pinSize,
      pinShadow, JSON.stringify(style), selected, resolution].join("|");
    if ( key === this.key ) return;
    this.key = key;
    const size = unit * (MARKER_SIZES[marker.size] ?? 1) * pinSize;
    const pixel = 1 / resolution;
    this.pixel = pixel;
    this.shadow = pinShadow;
    // Text is a bitmap: render it at the hologram's resolution, and sharp enough to be scaled up by perspective.
    this.text.resolution = resolution * MAX_SCALE;
    const color = new PIXI.Color(marker.color).toNumber();
    const radius = size * (selected ? 1.35 : 1);

    this.head.clear();
    const shape = GLYPH_SHAPES[marker.glyph];
    const trace = () => {
      if ( shape ) this.head.drawPolygon(shape.map(p => p * radius));
      else this.head.drawCircle(0, 0, radius * 0.85);
    };
    const outline = (width, alpha, fill) => {
      this.head.lineStyle({width, color, alpha, join: PIXI.LINE_JOIN.ROUND});
      if ( fill ) this.head.beginFill(color, fill);
      trace();
      if ( fill ) this.head.endFill();
    };
    this.icon.visible = false;
    this.halo.visible = false;
    this.shadowSprite.visible = false;
    // Another glyph: forget the picture, so one still loading doesn't clear the head when it arrives.
    if ( marker.glyph !== IMAGE_GLYPH ) this.iconSrc = null;
    if ( marker.glyph === IMAGE_GLYPH ) {
      // A picture, recoloured with the ink unless told not to. Until it has loaded (or if it can't), a disc of the ink.
      const standIn = () => {
        if ( pinShadow > 0 ) {
          this.head.lineStyle({width: radius * 0.5, color: SHADOW_COLOR, alpha: 0.35 * pinShadow})
            .drawCircle(0, 0, radius * 1.05);
        }
        this.head.lineStyle(0).beginFill(color, 0.16).drawCircle(0, 0, radius * 1.05).endFill();
        this.head.lineStyle({width: Math.max(pixel, radius * (selected ? 0.14 : 0.06)), color, alpha: selected ? 0.95 : 0.5})
          .drawCircle(0, 0, radius * 1.05);
      };
      this.halo.tint = color;
      this.halo.alpha = HALO_ALPHA * (selected ? 1.6 : 1) * (1 - (0.45 * pinShadow));
      this.shadowSprite.alpha = Math.min(1, pinShadow * 0.92);
      if ( !this.#showIcon(marker.image, radius * 2, marker.tint ? color : 0xffffff) ) standIn();
    }
    else if ( marker.glyph === "portal" ) {
      // A map placed here: an open ring around a bright core.
      if ( pinShadow > 0 ) {
        this.head.lineStyle({width: radius * 0.72, color: SHADOW_COLOR, alpha: 0.28 * pinShadow}).drawCircle(0, 0, radius);
        this.head.lineStyle({width: radius * 0.36, color: SHADOW_COLOR, alpha: 0.55 * pinShadow}).drawCircle(0, 0, radius);
        this.head.lineStyle(0).beginFill(SHADOW_COLOR, 0.5 * pinShadow).drawCircle(0, 0, radius * 0.62).endFill();
      }
      this.head.lineStyle({width: radius * 0.9, color, alpha: 0.18 * (1 - (0.4 * pinShadow))}).drawCircle(0, 0, radius);
      this.head.lineStyle({width: Math.max(pixel, radius * 0.2), color, alpha: 1}).drawCircle(0, 0, radius);
      this.head.lineStyle(0).beginFill(color, selected ? 1 : 0.85).drawCircle(0, 0, radius * 0.42).endFill();
    }
    else {
      if ( pinShadow > 0 ) {
        this.head.lineStyle({width: radius * 0.72, color: SHADOW_COLOR, alpha: 0.25 * pinShadow, join: PIXI.LINE_JOIN.ROUND});
        trace();
        this.head.lineStyle({width: radius * 0.36, color: SHADOW_COLOR, alpha: 0.52 * pinShadow, join: PIXI.LINE_JOIN.ROUND})
          .beginFill(SHADOW_COLOR, 0.45 * pinShadow);
        trace();
        this.head.endFill();
      }
      outline(radius * 0.9, 0.18 * (1 - (0.4 * pinShadow))); // glow
      outline(Math.max(pixel, radius * 0.22), 1, selected ? 0.75 : 0.45);
    }

    this.hasLabel = !!marker.label;
    if ( this.hasLabel ) {
      const font = Math.max(MIN_FONT,
        Math.round(unit * (LABEL_TIERS[marker.size] ?? 1) * LABEL_FONT * style.size * 10) / 10);
      setLabelText(this.text, marker.label.toUpperCase(), font, style);
      const padX = font * 0.4;
      const padY = font * 0.2;
      const w = this.text.width + (padX * 2);
      const h = this.text.height + (padY * 2);
      this.labelBox.clear()
        .lineStyle({width: outlineWidth(font, 0.08, style, resolution), color, alpha: 0.8})
        .beginFill(0x08050a, 0.72)
        .drawRoundedRect(0, 0, w, h, font * 0.2)
        .endFill();
      this.text.position.set(padX, centredTextY(this.text, h));
      this.labelSize = {w, h};
      this.gap = (radius * 1.2) + (font * 0.3);
    }
    else this.label.visible = false;
    this.color = color;
    this.size = size;
    this.radius = radius;
    this.fadeStem = marker.glyph === IMAGE_GLYPH;
  }

  /**
   * Show a picture as the glyph, fitted into a square of `extent` pixels. It loads in the background (once: Foundry
   * caches it), and never shows if it fails to; when it has loaded, it replaces whatever stood in for it on the head.
   * @returns {boolean}   Whether it's on show already
   */
  #showIcon(src, extent, tint) {
    this.icon.tint = tint;
    this.iconExtent = extent;
    if ( (src === this.iconSrc) && (this.icon.texture !== PIXI.Texture.EMPTY) ) {
      this.#fitIcon();
      return true;
    }
    if ( src === this.iconSrc ) return false; // Still loading
    this.iconSrc = src;
    this.icon.texture = PIXI.Texture.EMPTY;
    this.halo.texture = PIXI.Texture.EMPTY;
    this.shadowSprite.texture = PIXI.Texture.EMPTY;
    const loadTexture = foundry.canvas.loadTexture ?? globalThis.loadTexture;
    loadTexture(src).then(texture => {
      if ( !texture || this.destroyed || (this.iconSrc !== src) ) return;
      this.head.clear();
      this.icon.texture = texture;
      this.halo.texture = haloOf(texture, src);
      this.#fitIcon();
    }).catch(err => console.warn(`Vira Holo | Pin image ${src} didn't load:`, err));
    return false;
  }

  #fitIcon() {
    const {width, height} = this.icon.texture;
    this.icon.scale.set(this.iconExtent / Math.max(width, height, 1));
    this.halo.scale.set(this.iconExtent / HALO_ICON);
    this.icon.visible = true;
    this.halo.visible = true;
    if ( this.shadow > 0 ) {
      if ( this.shadowSprite.texture === PIXI.Texture.EMPTY ) {
        this.shadowSprite.texture = shadowOf(this.icon.texture, this.iconSrc);
      }
      this.shadowSprite.scale.set(this.iconExtent / HALO_ICON);
      this.shadowSprite.visible = true;
    }
    else this.shadowSprite.visible = false;
  }

  /**
   * Where the label goes for a head position and side, at a scale.
   * @returns {{x: number, y: number, w: number, h: number}}
   */
  labelRect(head, side, scale) {
    const w = this.labelSize.w * scale;
    const h = this.labelSize.h * scale;
    const gap = this.gap * scale;
    const right = head.x + gap;
    const left = head.x - gap - w;
    return {x: left + ((right - left) * ((side + 1) / 2)), y: head.y - (h / 2), w, h};
  }

  /** The box the head covers at a position and scale. */
  headRect(head, scale) {
    const r = this.size * scale;
    return {x: head.x - r, y: head.y - r, w: 2 * r, h: 2 * r};
  }

  /**
   * How far a place moves the head from where it stands, in pixels.
   * @param {number[]} place              [rise, lean, side] (see PLACES)
   * @param {{x: number, y: number}} up   Which way is up on screen at the head (a unit vector)
   * @param {number} scale
   */
  offset([rise, lean, side], up, scale) {
    const icon = 2 * this.size * scale;
    return {x: ((up.x * rise) + (lean * side)) * icon, y: up.y * rise * icon};
  }

  /**
   * Draw the waypoint between its surface point and its head (render-texture pixels).
   * @param {{x: number, y: number}} base
   * @param {{x: number, y: number}} head
   * @param {number} groundSquash   How flat the ground ring looks (sine of the camera pitch)
   * @param {number} alpha
   * @param {number} scale          Perspective: how much bigger than usual the head and label are drawn
   */
  render(base, head, groundSquash, alpha, scale) {
    const {color, size, pixel, shadow} = this;
    this.stem.clear();
    if ( shadow > 0 ) {
      this.#stemLine(base, head, Math.max(pixel * 2.5, size * 0.46), 0.48 * shadow, scale, SHADOW_COLOR);
    }
    this.#stemLine(base, head, size * 0.6, 0.15 * (1 - (0.4 * shadow)), scale, color);
    this.#stemLine(base, head, Math.max(pixel, size * 0.15), 0.9, scale, color);
    const ring = size * 0.68 * scale;
    const ringY = ring * Math.max(groundSquash, 0.15);
    const ringWidth = Math.max(pixel, size * 0.11);
    this.ground.clear();
    if ( shadow > 0 ) {
      this.ground.lineStyle({width: Math.max(pixel * 2.5, ringWidth * 2.6), color: SHADOW_COLOR, alpha: 0.42 * shadow})
        .drawEllipse(base.x, base.y, ring, ringY);
    }
    this.ground.lineStyle({width: ringWidth, color, alpha: 0.55})
      .drawEllipse(base.x, base.y, ring, ringY);
    this.head.position.set(head.x, head.y);
    this.head.scale.set(scale);
    this.label.visible = this.hasLabel && (this.labelAlpha > 0.01);
    if ( this.label.visible ) {
      const box = this.labelRect(head, this.side, scale);
      this.label.position.set(box.x, box.y);
      this.label.scale.set(scale);
      this.label.alpha = this.labelAlpha;
    }
    this.container.alpha = alpha;
    this.container.visible = alpha > 0.01;
    this.base = base;
    this.tip = head;
    this.reach = size * scale * 1.8;
  }

  /** One line of the stem; an image pin's fades out as it goes into the picture (see STEM_FADE). */
  #stemLine(base, head, width, alpha, scale, color) {
    const dx = head.x - base.x;
    const dy = head.y - base.y;
    const length = Math.hypot(dx, dy);
    if ( !this.fadeStem || !length ) {
      this.stem.lineStyle({width, color, alpha}).moveTo(base.x, base.y).lineTo(head.x, head.y);
      return;
    }
    // Points by their distance from the head
    const at = d => ({x: head.x - (dx * d / length), y: head.y - (dy * d / length)});
    const [from, to] = STEM_FADE.map(r => r * this.radius * scale);
    if ( from < length ) {
      const p = at(from);
      this.stem.lineStyle({width, color, alpha}).moveTo(base.x, base.y).lineTo(p.x, p.y);
    }
    for ( let i = 0; i < STEM_FADE_STEPS; i++ ) {
      const near = from + ((to - from) * (i + 1) / STEM_FADE_STEPS);
      if ( near >= length ) continue;
      const p = at(Math.min(from + ((to - from) * i / STEM_FADE_STEPS), length));
      const q = at(near);
      const fade = 1 - ((i + 0.5) / STEM_FADE_STEPS);
      this.stem.lineStyle({width, color, alpha: alpha * fade * fade}).moveTo(p.x, p.y).lineTo(q.x, q.y);
    }
  }

  destroy() {
    this.destroyed = true;
    // Foundry's cache owns the picture, and the halos and shadows are kept for other pins.
    this.icon.texture = PIXI.Texture.EMPTY;
    this.halo.texture = PIXI.Texture.EMPTY;
    this.shadowSprite.texture = PIXI.Texture.EMPTY;
    this.container.destroy({children: true});
  }
}

/**
 * All waypoints of one hologram, drawn into its render texture above the content. Their labels are laid out to
 * keep clear of each other: each in turn, most important first, takes the first free place among PLACES (flipping
 * sides, raising its pin, then tipping its pin over); a label with no free place fades out until there is one, or
 * while its pin is hovered or selected.
 */
export default class MarkerLayer {
  /** @type {Map<string, MarkerSprite>} */
  #sprites = new Map();
  #last = null;

  /** @param {PIXI.Container} parent   Where the pins go: drawn far to near with the other labels (by zIndex) */
  constructor(parent) {
    this.parent = parent;
  }

  /**
   * Create, update and remove sprites to match the waypoints.
   * @param {object[]} markers
   * @param {{size: number, pinSize: number, pinShadow: number, label: object, selected: string|null,
   *          resolution: number}} options
   *   label: how labels are drawn (see labelStyle)
   */
  sync(markers, {size, pinSize=1, pinShadow=0, label, selected, resolution=1}) {
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
        this.parent.addChild(sprite.container);
      }
      sprite.draw(marker, size, pinSize, pinShadow, label, marker.id === selected, resolution);
    }
  }

  /** @returns {MarkerSprite|undefined} */
  get(id) {
    return this.#sprites.get(id);
  }

  /** Where the labels shown always were laid out (last frame): measurement labels keep clear of them too. */
  get alwaysBoxes() {
    return Array.from(this.#sprites.values())
      .filter(s => (s.labelShow === "always") && s.shown && s.box && s.container.visible).map(s => s.box);
  }

  /**
   * Lay out and draw the pins for this frame.
   * @param {object[]} pins   {id, tier, base, head, up (unit vector: which way is up on screen at the head), depth,
   *                          scale, alpha}, for each pin in front of the camera
   * @param {{x: number, y: number, w: number, h: number}[]} obstacles   Labels that stay put
   * @param {object} options
   * @param {number} options.width       The render texture's size
   * @param {number} options.height
   * @param {number} options.squash      How flat ground rings look
   * @param {boolean} options.labels     Whether pins' labels are shown (else only while hovered or selected)
   * @param {boolean} options.lean       Whether pins may lean
   * @param {string[]} options.focus     The hovered or selected pins
   * @param {string} options.mode        How to lay out (see HoloRenderer#layoutMode): afresh ("fresh"), not at all
   *                                     ("hold"), or keeping places ("follow")
   */
  layout(pins, obstacles, {width, height, squash, labels, lean, focus, mode}) {
    const fresh = mode === "fresh";
    const now = performance.now();
    const dt = Math.clamp(now - (this.#last ?? now), 0, 100);
    this.#last = now;
    const ease = 1 - Math.exp(-dt / EASE_MS);
    const ids = new Set(pins.map(pin => pin.id));
    for ( const [id, sprite] of this.#sprites ) {
      if ( !ids.has(id) ) sprite.container.visible = false;
    }
    for ( const pin of pins ) pin.sprite = this.#sprites.get(pin.id);
    // Pins outside the projection area take no room.
    const live = pins.filter(pin => pin.alpha > 0.05);
    for ( const pin of live ) pin.headBox = pin.sprite.headRect(pin.head, pin.scale);
    const taken = [...obstacles];
    // Bigger pins first; while the view moves, a label already shown keeps its place ahead of one waiting to show;
    // then nearer first.
    // Labels shown always come first (the others make way for them), then bigger pins; while the view moves, a label
    // already shown keeps its place ahead of one waiting to show; then nearer first. Hover-only labels take no room.
    const always = pin => Number(pin.sprite.labelShow === "always");
    const order = live.filter(pin => labels && pin.sprite.hasLabel && (pin.sprite.labelShow !== "hover"))
      .sort((a, b) => (always(b) - always(a)) || (b.tier - a.tier)
        || (fresh ? 0 : Number(b.sprite.shown) - Number(a.sprite.shown)) || (a.depth - b.depth));
    const placing = new Set(order);
    for ( const pin of pins ) {
      if ( !placing.has(pin) ) pin.sprite.shown = false;
    }
    const places = lean ? PLACES.length : UPRIGHT;
    // Where labels not placed yet this frame were last frame: a label only tidies itself into room none of them uses.
    const waiting = new Set(order.filter(pin => pin.sprite.shown && pin.sprite.box));
    for ( const pin of order ) {
      if ( mode === "hold" ) break;
      waiting.delete(pin);
      this.#place(pin, live, taken, {width, height}, places, now, fresh ? null : Array.from(waiting, other => other.sprite.box));
    }
    for ( const pin of pins ) this.#animate(pin, focus.includes(pin.id), squash, ease);
  }

  /**
   * Find a pin's label a place. A label shown keeps its place until that gets covered (more than TOLERANCE of it),
   * then moves to the nearest free one; it moves to a place earlier in PLACES only once that has stayed free a while
   * (BETTER_MS), so labels don't hop about as the view turns. A hidden label shows at the first free place once
   * there has been one for SETTLE_MS.
   * @param {number} count   How many of PLACES may be used
   * @param {object[]|null} others   Boxes of the labels shown that are still to be placed; null to lay out afresh: the
   *                          first free place, at once
   */
  #place(pin, pins, taken, bounds, count, now, others) {
    const sprite = pin.sprite;
    // Worked out only as needed: usually just the place a label already has.
    const fits = [];
    const fit = index => {
      if ( index >= count ) return null;
      if ( fits[index] === undefined ) fits[index] = this.#fit(pin, PLACES[index], pins, taken, bounds);
      return fits[index];
    };
    const firstFree = to => {
      for ( let index = 0; index < to; index++ ) {
        if ( fit(index)?.cover === 0 ) return index;
      }
      return -1;
    };
    const leastCovered = () => {
      let least = 0;
      for ( let index = 1; index < count; index++ ) {
        if ( fit(index).cover < fit(least).cover ) least = index;
      }
      return least;
    };
    const always = sprite.labelShow === "always";
    let target = -1;
    if ( !others ) target = firstFree(count);
    else if ( sprite.shown ) {
      const current = fit(sprite.place);
      const area = sprite.labelSize.w * sprite.labelSize.h * pin.scale * pin.scale;
      if ( current && (current.cover <= area * TOLERANCE) ) {
        target = sprite.place;
        const free = firstFree(sprite.place);
        if ( (free < 0) || others.some(box => overlap(fits[free].label, box) > 0) ) sprite.better = null;
        else if ( sprite.better?.index !== free ) sprite.better = {index: free, since: now};
        else if ( now - sprite.better.since >= BETTER_MS ) target = free;
      }
      else {
        // Covered: the nearest free place, not the first, so the label moves as little as it can.
        let nearest = Infinity;
        for ( let index = 0; index < count; index++ ) {
          const place = fit(index);
          if ( place?.cover !== 0 ) continue;
          const from = current?.label ?? place.label;
          const distance = Math.hypot(place.label.x - from.x, place.label.y - from.y);
          if ( distance < nearest ) [nearest, target] = [distance, index];
        }
      }
    }
    else {
      const free = firstFree(count);
      if ( free < 0 ) sprite.freeSince = null;
      else {
        sprite.freeSince ??= now;
        if ( always || (now - sprite.freeSince >= SETTLE_MS) ) target = free;
      }
    }
    // A label shown always shows even where there's no room: where it is, else where it's covered least.
    if ( (target < 0) && always ) target = (sprite.shown && fit(sprite.place)) ? sprite.place : leastCovered();
    if ( target < 0 ) {
      sprite.shown = false;
      sprite.better = null;
      sprite.box = null;
      return;
    }
    if ( target !== sprite.place ) sprite.better = null;
    sprite.place = target;
    sprite.shown = true;
    sprite.freeSince = null;
    taken.push(fits[target].label);
    sprite.box = fits[target].label;
    pin.headBox = fits[target].head;
  }

  /**
   * How a pin's label would fit at a place: its and its head's boxes, and how much of them other labels and heads
   * would cover (infinitely much if the label would stick out of the render texture).
   * @returns {{label: object, head: object, cover: number}}
   */
  #fit(pin, place, pins, taken, {width, height}) {
    const {sprite, scale} = pin;
    const [rise, lean, side] = place;
    const {x: dx, y: dy} = sprite.offset(place, pin.up, scale);
    const head = {x: pin.head.x + dx, y: pin.head.y + dy};
    const label = sprite.labelRect(head, side, scale);
    const headBox = ((rise === 0) && (lean === 0)) ? pin.headBox : sprite.headRect(head, scale);
    if ( (label.x < 0) || (label.y < 0) || (label.x + label.w > width) || (label.y + label.h > height) ) {
      return {label, head: headBox, cover: Infinity};
    }
    let cover = 0;
    for ( const box of taken ) cover += overlap(label, box) + overlap(headBox, box);
    for ( const other of pins ) {
      if ( other !== pin ) cover += overlap(label, other.headBox);
    }
    return {label, head: headBox, cover};
  }

  /** Ease a pin towards its layout (or, focused, show its label whatever) and draw it. */
  #animate(pin, focused, squash, ease) {
    const {sprite, base, up, scale, depth, alpha} = pin;
    const place = sprite.shown ? PLACES[sprite.place] : [0, 0, sprite.side >= 0 ? 1 : -1];
    const offset = sprite.offset(place, up, scale);
    sprite.dx += (offset.x - sprite.dx) * ease;
    sprite.dy += (offset.y - sprite.dy) * ease;
    sprite.side += (place[2] - sprite.side) * ease;
    sprite.labelAlpha += (((sprite.shown || focused) ? 1 : 0) - sprite.labelAlpha) * ease;
    const head = {x: pin.head.x + sprite.dx, y: pin.head.y + sprite.dy};
    sprite.container.zIndex = focused ? FOCUS_Z : -depth;
    sprite.render(base, head, squash, alpha, scale);
  }

  /**
   * The waypoint whose head or base is within reach of a render-texture point. A head beats a base (another pin's
   * base may sit right behind a head); then the front-most (as drawn: a hovered pin is on top), then the nearest.
   * @param {number} x
   * @param {number} y
   * @returns {string|null}
   */
  hitTest(x, y) {
    let best = null;
    for ( const [id, sprite] of this.#sprites ) {
      if ( !sprite.container.visible || !sprite.tip ) continue;
      const toHead = Math.hypot(x - sprite.tip.x, y - sprite.tip.y);
      const head = toHead <= sprite.reach;
      const distance = Math.min(toHead, Math.hypot(x - sprite.base.x, y - sprite.base.y));
      if ( distance > sprite.reach ) continue;
      const z = sprite.container.zIndex;
      const better = !best || ((head !== best.head) ? head
        : ((z !== best.z) ? (z > best.z) : (distance < best.distance)));
      if ( better ) best = {id, z, distance, head};
    }
    return best?.id ?? null;
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
