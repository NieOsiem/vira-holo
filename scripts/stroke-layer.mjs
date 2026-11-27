import {STROKE_WIDTHS} from "./data.mjs";

/**
 * Floats per vertex: position (3), previous point (3), next point (3), side (1), colour (3), width (1), distance
 * along the line (1), cap (1: -1/1 for the round cap past its start/end).
 */
const STRIDE = 16;
/** The glow pass is this much wider than the line. */
const GLOW_SCALE = 2.6;
/** Most points a single stroke segment is split into to follow the terrain. */
const MAX_SUBDIVISIONS = 64;
/** Cosine of the turn beyond which a corner is rounded off rather than mitred (about 80°). */
const SHARP_CORNER = 0.17;
/** Shortest segment kept, in object units (a few screen pixels on a hologram at normal size). */
const MIN_SEGMENT = 0.012;

/**
 * Freehand strokes of one hologram as a single line mesh, drawn twice (soft glow, then the line). The mesh holds
 * object-space points and is only rebuilt when the strokes or the surface under them change; the camera is applied
 * on the GPU, so turning the hologram costs nothing here.
 */
export default class StrokeLayer {
  container = new PIXI.Container();
  #key = null;
  /** @type {{id: string, width: number, positions: {x: number, y: number, z: number}[]}[]} As last built, for picking. */
  lines = [];

  /**
   * @param {PIXI.Program} program
   * @param {object} uniforms     Camera and projection-area uniforms shared with the rest of the hologram
   * @param {PIXI.State} state
   * @param {object} [options]
   * @param {number} [options.dash=0]   Dashes per object-space unit along each line; 0 draws solid lines
   */
  constructor(program, uniforms, state, {dash=0}={}) {
    this.vertices = new PIXI.Buffer(new Float32Array(STRIDE), false);
    this.indices = new PIXI.Buffer(new Uint32Array(3), false, true);
    const bytes = STRIDE * 4;
    const {FLOAT} = PIXI.TYPES;
    this.geometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", this.vertices, 3, false, FLOAT, bytes, 0)
      .addAttribute("aPrev", this.vertices, 3, false, FLOAT, bytes, 12)
      .addAttribute("aNext", this.vertices, 3, false, FLOAT, bytes, 24)
      .addAttribute("aSide", this.vertices, 1, false, FLOAT, bytes, 36)
      .addAttribute("aColor", this.vertices, 3, false, FLOAT, bytes, 40)
      .addAttribute("aWidth", this.vertices, 1, false, FLOAT, bytes, 52)
      .addAttribute("aDistance", this.vertices, 1, false, FLOAT, bytes, 56)
      .addAttribute("aCap", this.vertices, 1, false, FLOAT, bytes, 60)
      .addIndex(this.indices);
    const pass = extra => new PIXI.Shader(program, {...uniforms, uOpacity: 1, uFlicker: 1, uWidth: 1, uPixel: 1,
      uDash: dash, uDashPhase: 0, ...extra});
    this.shaders = [pass({uWidthScale: GLOW_SCALE, uAlpha: 0.4, uSoft: 1}), pass({uWidthScale: 1, uAlpha: 1, uSoft: 0})];
    this.container.addChild(...this.shaders.map(shader => new PIXI.Mesh(this.geometry, shader, state)));
    this.container.visible = false;
  }

  /**
   * Rebuild the mesh if anything it depends on changed.
   * @param {object[]} strokes                  Sanitized strokes
   * @param {string} key                        Changes whenever the strokes or the surface do
   * @param {(u: number, v: number) => {x: number, y: number, z: number}} surface   Object-space surface point
   * @param {number} step                       Longest segment in UV before it is split to follow the surface; 0 never
   */
  sync(strokes, key, surface, step) {
    if ( key === this.#key ) return;
    this.#key = key;
    const lines = strokes.filter(stroke => stroke.points.length >= 4).map(({id, points, color, width}) => ({
      id,
      points: resample(points, step),
      color: new PIXI.Color(color).toRgbArray(),
      width: STROKE_WIDTHS[width] ?? 1
    }));
    for ( const line of lines ) {
      line.positions = [];
      for ( let i = 0; i < line.points.length; i += 2 ) line.positions.push(surface(line.points[i], line.points[i + 1]));
      line.positions = dropCrowded(line.positions);
    }
    this.lines = lines.map(({id, width, positions}) => ({id, width, positions}));
    // Sharp corners would stick out as long mitre spikes: lines are drawn as runs between them, each with round caps,
    // which round the corner off. Distances carry on across runs so dashes don't restart.
    const runs = lines.flatMap(({positions, color, width}) => splitAtCorners(positions).map(run => ({...run, color, width})));
    // Two vertices per point, plus a pair past each end of a run for its round cap.
    const vertexCount = runs.reduce((n, run) => n + ((run.positions.length + 2) * 2), 0);
    this.container.visible = runs.length > 0;
    if ( !runs.length ) return;
    const vertices = new Float32Array(vertexCount * STRIDE);
    const indices = new Uint32Array(runs.reduce((n, run) => n + ((run.positions.length + 1) * 6), 0));
    let vertex = 0;
    let index = 0;
    for ( const {positions, color, width, start} of runs ) {
      const count = positions.length;
      const first = vertex;
      let distance = start;
      const pair = (here, prev, next, cap) => {
        for ( const side of [-1, 1] ) {
          vertices.set([here.x, here.y, here.z, prev.x, prev.y, prev.z, next.x, next.y, next.z, side, ...color, width,
            distance, cap], vertex * STRIDE);
          vertex++;
        }
      };
      pair(positions[0], positions[0], positions[1], -1);
      for ( let i = 0; i < count; i++ ) {
        const here = positions[i];
        const prev = positions[Math.max(i - 1, 0)];
        distance += Math.hypot(here.x - prev.x, here.y - prev.y, here.z - prev.z);
        pair(here, prev, positions[Math.min(i + 1, count - 1)], 0);
      }
      pair(positions[count - 1], positions[count - 2], positions[count - 1], 1);
      for ( let i = 0; i < count + 1; i++ ) {
        const a = first + (i * 2);
        indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], index);
        index += 6;
      }
    }
    this.vertices.update(vertices);
    this.indices.update(indices);
  }

  /**
   * Per-frame look: opacity, flicker, the half width of a medium stroke and one device pixel (both in layout pixels)
   * and how far dashes have marched (0..1).
   */
  update({opacity, flicker, width, pixel=1, dashPhase=0}) {
    for ( const {uniforms} of this.shaders ) {
      uniforms.uPixel = pixel;
      uniforms.uOpacity = opacity;
      uniforms.uFlicker = flicker;
      uniforms.uWidth = width;
      uniforms.uDashPhase = dashPhase;
    }
  }

  /** Use another render state (depth testing) for both passes. */
  setState(state) {
    for ( const mesh of this.container.children ) mesh.state = state;
  }

  destroy() {
    this.container.destroy({children: true});
    this.geometry.destroy();
    this.vertices.destroy();
    this.indices.destroy();
  }
}

/**
 * Split a line into runs at corners sharper than SHARP_CORNER, each run starting where the last one ended.
 * @param {{x: number, y: number, z: number}[]} positions
 * @returns {{positions: {x: number, y: number, z: number}[], start: number}[]}   start: distance along the line
 */
function splitAtCorners(positions) {
  const runs = [{positions: [positions[0]], start: 0}];
  let distance = 0;
  for ( let i = 1; i < positions.length; i++ ) {
    const [a, b] = [positions[i - 1], positions[i]];
    const run = runs.at(-1);
    run.positions.push(b);
    distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const c = positions[i + 1];
    if ( !c ) break;
    const [ux, uy, uz] = [b.x - a.x, b.y - a.y, b.z - a.z];
    const [vx, vy, vz] = [c.x - b.x, c.y - b.y, c.z - b.z];
    const cos = ((ux * vx) + (uy * vy) + (uz * vz)) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1);
    if ( cos < SHARP_CORNER ) runs.push({positions: [b], start: distance});
  }
  return runs;
}

/**
 * Drop points almost on top of the one before (a jitter as the pen lifts leaves a tiny hook whose sharp join and cap
 * stick out as a spike), always keeping both ends.
 * @param {{x: number, y: number, z: number}[]} positions
 * @returns {{x: number, y: number, z: number}[]}
 */
function dropCrowded(positions) {
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < MIN_SEGMENT;
  const kept = [positions[0]];
  for ( const point of positions.slice(1, -1) ) if ( !near(point, kept.at(-1)) ) kept.push(point);
  const last = positions.at(-1);
  if ( (kept.length > 1) && near(last, kept.at(-1)) ) kept.pop();
  kept.push(last);
  return kept;
}

/**
 * Split long segments of a flat [u, v, ...] list so none is longer than `step`, letting a line drawn across a hill
 * follow its slope instead of cutting through it.
 * @param {number[]} points
 * @param {number} step
 * @returns {number[]}
 */
function resample(points, step) {
  if ( !step ) return points;
  const out = [points[0], points[1]];
  for ( let i = 2; i < points.length; i += 2 ) {
    const [u0, v0, u1, v1] = [points[i - 2], points[i - 1], points[i], points[i + 1]];
    const parts = Math.clamp(Math.ceil(Math.hypot(u1 - u0, v1 - v0) / step), 1, MAX_SUBDIVISIONS);
    for ( let k = 1; k <= parts; k++ ) out.push(u0 + (((u1 - u0) * k) / parts), v0 + (((v1 - v0) * k) / parts));
  }
  return out;
}

/**
 * Drop the points of a freehand stroke that barely change its shape (Ramer–Douglas–Peucker), then thin it evenly
 * if it is still longer than allowed.
 * @param {number[]} points     Flat [u, v, ...] list
 * @param {number} tolerance    Largest distance (UV) a dropped point may lie from the simplified line
 * @param {number} max          Most points to keep
 * @returns {number[]}
 */
export function simplifyStroke(points, tolerance, max) {
  const count = points.length / 2;
  const keep = new Uint8Array(count);
  keep[0] = keep[count - 1] = 1;
  const stack = [[0, count - 1]];
  while ( stack.length ) {
    const [a, b] = stack.pop();
    const [ax, ay] = [points[a * 2], points[(a * 2) + 1]];
    const [dx, dy] = [points[b * 2] - ax, points[(b * 2) + 1] - ay];
    const length2 = (dx * dx) + (dy * dy);
    let farthest = -1;
    let distance = tolerance;
    for ( let i = a + 1; i < b; i++ ) {
      const [px, py] = [points[i * 2] - ax, points[(i * 2) + 1] - ay];
      const t = length2 ? Math.clamp(((px * dx) + (py * dy)) / length2, 0, 1) : 0;
      const d = Math.hypot(px - (t * dx), py - (t * dy));
      if ( d > distance ) {
        distance = d;
        farthest = i;
      }
    }
    if ( farthest < 0 ) continue;
    keep[farthest] = 1;
    stack.push([a, farthest], [farthest, b]);
  }
  let kept = [];
  for ( let i = 0; i < count; i++ ) if ( keep[i] ) kept.push(i);
  if ( kept.length > max ) kept = Array.from({length: max}, (_, k) => kept[Math.round((k * (kept.length - 1)) / (max - 1))]);
  return kept.flatMap(i => [points[i * 2], points[(i * 2) + 1]]);
}
