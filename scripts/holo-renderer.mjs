import {MEASURE_INK, UNITS, formatDistance, getHoloData} from "./data.mjs";
import MarkerLayer from "./marker-layer.mjs";
import MeasureLayer from "./measure-layer.mjs";
import StrokeLayer from "./stroke-layer.mjs";
import TextPanel from "./text-panel.mjs";

const TAU = Math.PI * 2;
const FOCAL = 2.6;
/** Camera distance at which the projector footprint fills FILL of the tile. */
const BASE_DIST = 4.8;
const FILL = 0.85;
export const MIN_DIST = 2.2;
export const MAX_DIST = 14;
export const MIN_PITCH = 0.15;
export const MAX_PITCH = Math.PI / 2;
/**
 * Longest side of the hologram's layout space, in which it is laid out and picked ("texture pixels"): the tile's
 * own size up to this. What is actually rendered is the part of it on screen, at the screen's pixel density.
 */
const MAX_LAYOUT_SIZE = 2048;
/**
 * Device pixels across the hologram's longer side that a small hologram is supersampled up to, by at most
 * MAX_SUPERSAMPLE: bilinear sampling only averages 2×2 texels, so more would alias rather than smooth.
 */
const MIN_RENDER_PIXELS = 512;
const MAX_SUPERSAMPLE = 2;
/** Largest render texture side, whatever the GPU allows. */
const MAX_RENDER_SIZE = 8192;
const DISC_RADIUS = 1.08;
/** One scanline per this many scene pixels of tile height. */
const SCANLINE_SPACING = 6;
/** Waypoint stem height, in footprint units. */
const STEM_HEIGHT = 0.16;
/** Longest side of the CPU copy of a heightmap, used to stand waypoints on the terrain and to pick points on it. */
const HEIGHT_SAMPLES = 512;
/** How long a new or erased stroke or measurement shows that way here while the GM saves it. */
const PENDING_MS = 3000;
/** Time constant (ms) with which another user's camera is eased towards, between their 30-per-second updates. */
const CAMERA_EASE_MS = 40;
/** How long another user's stroke or measurement in progress stays shown without news from them. */
const REMOTE_PREVIEW_MS = 3000;
/** Dashes per footprint unit along a measurement line. */
const MEASURE_DASHES = 14;
/** Approximate number of wireframe lines across the terrain in each direction. */
const WIRE_LINES = 40;
const CONTOUR_LEVELS = 12;
/**
 * View depth mapped to the far end of the depth buffer (the near end is the camera). Everything drawn is well within
 * it at any camera distance, so one fixed range serves every mesh, the projector disc's own camera included.
 */
const DEPTH_FAR = 24;
/** How far (in depth-buffer units) wireframe and strokes resting on the terrain are pulled towards the camera. */
const WIRE_DEPTH_BIAS = 0.0006;
const STROKE_DEPTH_BIAS = 0.003;
/** How long the hologram takes to settle after travelling to another map. */
const TRAVEL_MS = 700;
/** Content scale a travel starts from: a map entered grows into view, a parent shrinks into it. */
const TRAVEL_SCALE = {in: 0.3, out: 2.5};
/** Most data motes, at full density. */
const MAX_MOTES = 160;
/** Mote animation repeats every this many seconds; each mote rises a whole number of times per period. */
const MOTE_PERIOD = 20;

/**
 * Projects an object-space point (x right, y up, z away from the default viewer) through the orbit camera.
 * view() gives camera space with y pointing down the render texture; project() leaves the perspective divide to the
 * GPU (w = view depth) so varyings interpolate perspective-correctly.
 */
const PROJECT = `
vec3 view(vec3 p) {
  p.xz -= uTarget;
  float cy = cos(uCamera.x), sy = sin(uCamera.x), cp = cos(uCamera.y), sp = sin(uCamera.y);
  float x = p.x * cy + p.z * sy;
  float z1 = p.z * cy - p.x * sy;
  float y = p.y * cp + z1 * sp;
  float z = z1 * cp - p.y * sp;
  return vec3(x, -y, z);
}
// offset: pixels from the centre, times w (the GPU divides by w). Depth is linear in w over [0, DEPTH_FAR]; bias pulls
// it towards the camera, for lines lying on a surface.
vec4 clipFrom(vec2 offset, float w, float bias) {
  vec3 clip = projectionMatrix * translationMatrix * vec3(uCenter * w + offset, w);
  return vec4(clip.xy, (2.0 * w / ${DEPTH_FAR.toFixed(1)} - 1.0 - bias) * w, w);
}
vec4 projectBiased(vec3 p, float bias) {
  vec3 v = view(p);
  vDepth = v.z;
  return clipFrom(v.xy * ${FOCAL.toFixed(2)} * uCamera.w, v.z + uCamera.z, bias);
}
vec4 project(vec3 p) {
  return projectBiased(p, 0.0);
}`;

const CAMERA_UNIFORMS = `
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec4 uCamera; // yaw, pitch, distance, render-texture pixels per unit
uniform vec2 uTarget; // floor point the camera looks at
uniform vec2 uCenter;`;

/** Fades content out towards the edge of the projection area, so panned or zoomed content never ends in a hard cut. */
const VOLUME = `
uniform vec3 uVolume; // layout width and height; z = 1 for a rectangular (sign) area, 0 for elliptical
uniform vec4 uFrag;   // layout position of the render texture's corner, and layout pixels per device pixel
// This fragment's position in layout pixels (only the on-screen part of the layout is rendered).
vec2 holoPixel() {
  return uFrag.xy + gl_FragCoord.xy * uFrag.zw;
}
float volumeFade() {
  vec2 q = abs((holoPixel() / uVolume.xy) * 2.0 - 1.0);
  float d = uVolume.z > 0.5 ? max(q.x, q.y) : length(q);
  return 1.0 - smoothstep(0.88, 1.0, d);
}`;

/** Shared by the image panel and terrain: hologram colouring of the source image, scanlines and flicker. */
const HOLO_LOOK = `${VOLUME}
uniform sampler2D uImage;
uniform vec3 uColor;
uniform float uTint;
uniform float uOpacity;
uniform float uSolidity;
uniform float uScan;
uniform float uScanDensity;
uniform float uScanPhase;
uniform float uFlicker;

float luminance(vec3 rgb) {
  return smoothstep(0.2, 0.8, dot(rgb, vec3(0.299, 0.587, 0.114)));
}

// The source image's colour (straight alpha), tinted towards the hologram colour.
vec3 holoTint(vec4 tex, float shade) {
  vec3 rgb = tex.a > 0.0 ? tex.rgb / tex.a : vec3(0.0);
  return mix(rgb, uColor * (0.1 + 1.4 * luminance(rgb)), uTint) * shade;
}

float scanline() {
  return 1.0 - uScan * 0.6 * (0.5 + 0.5 * sin((holoPixel().y * uScanDensity + uScanPhase) * 6.2831853));
}

// Returns premultiplied emitted colour (rgb) and its alpha (a) before solidity.
vec4 holoColor(vec4 tex, float shade) {
  vec3 rgb = tex.a > 0.0 ? tex.rgb / tex.a : vec3(0.0);
  // A hologram is emitted light: when tinted, dark parts of the image glow (and block) less.
  float emission = mix(1.0, 0.2 + 0.8 * luminance(rgb), uTint);
  float a = tex.a * emission * uOpacity * scanline() * uFlicker;
  return vec4(holoTint(tex, shade) * a, a);
}

float depthFade(float depth, float far) {
  return mix(1.0, far, clamp((depth + 1.0) * 0.5, 0.0, 1.0));
}`;

const VERTEX = `
precision highp float;
attribute vec3 aVertexPosition;
attribute vec2 aTextureCoord;
${CAMERA_UNIFORMS}
varying vec2 vUV;
varying float vDepth;
${PROJECT}
void main() {
  vUV = aTextureCoord;
  gl_Position = project(aVertexPosition);
}`;

const PANEL_FRAGMENT = `
precision highp float;
varying vec2 vUV;
varying float vDepth;
${HOLO_LOOK}
uniform vec2 uPanelShape; // panel extents with the longer side = 1, so the frame is equally thick on all sides
void main() {
  vec4 holo = holoColor(texture2D(uImage, vUV), 1.0) * depthFade(vDepth, 0.7);
  vec2 edge = min(vUV, 1.0 - vUV) * uPanelShape;
  float frame = smoothstep(0.012, 0.0, min(edge.x, edge.y));
  // Premultiplied output: alpha below brightness makes the hologram partly additive when composited.
  gl_FragColor = vec4(holo.rgb + uColor * frame * 0.8 * uFlicker, holo.a * uSolidity + frame * 0.2) * volumeFade();
}`;

const DISC_FRAGMENT = `
precision highp float;
varying vec2 vUV;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
uniform float uDashPhase;

void main() {
  float r = length(vUV);
  if ( r > 1.0 ) discard;
  float angle = atan(vUV.y, vUV.x) / 6.2831853 + 0.5;
  float ring = smoothstep(0.02, 0.0, abs(r - 0.93));
  float dashes = step(0.55, fract(angle * 64.0 + uDashPhase)) * smoothstep(0.012, 0.0, abs(r - 0.985));
  float pool = 0.12 * (1.0 - smoothstep(0.2, 0.93, r));
  float a = (ring * 0.7 + dashes * 0.5 + pool) * uOpacity * uFlicker;
  gl_FragColor = vec4(uColor * a, a * 0.25);
}`;

const TERRAIN_VERTEX = `#version 300 es
precision highp float;
in vec3 aVertexPosition;
in vec2 aTextureCoord;
${CAMERA_UNIFORMS}
uniform sampler2D uHeight;
uniform float uRelief;
uniform vec2 uTexel; // one grid cell in UV
uniform vec2 uCell;  // one grid cell in object space (x, z)
uniform float uDepthBias;
out vec2 vUV;
out float vDepth;
out float vHeight;
out float vShade;
${PROJECT}
void main() {
  vUV = aTextureCoord;
  float h = textureLod(uHeight, vUV, 0.0).r;
  float hl = textureLod(uHeight, vUV - vec2(uTexel.x, 0.0), 0.0).r;
  float hr = textureLod(uHeight, vUV + vec2(uTexel.x, 0.0), 0.0).r;
  float hFar = textureLod(uHeight, vUV - vec2(0.0, uTexel.y), 0.0).r;
  float hNear = textureLod(uHeight, vUV + vec2(0.0, uTexel.y), 0.0).r;
  vec3 normal = normalize(vec3((hl - hr) * uRelief / (2.0 * uCell.x), 1.0, (hNear - hFar) * uRelief / (2.0 * uCell.y)));
  vShade = 0.45 + 0.75 * max(dot(normal, normalize(vec3(-0.5, 0.75, 0.45))), 0.0);
  vHeight = h;
  vec3 p = aVertexPosition;
  p.y += h * uRelief;
  gl_Position = projectBiased(p, uDepthBias);
}`;

const TERRAIN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
in float vDepth;
in float vHeight;
in float vShade;
${HOLO_LOOK}
uniform float uContours;
uniform float uOpaque;    // 1: an opaque surface (it also fills the depth buffer)
uniform float uDepthOnly; // 1: only fill the depth buffer, so the wireframe behind hills is hidden
out vec4 fragColor;

void main() {
  if ( uDepthOnly > 0.5 ) {
    fragColor = vec4(0.0);
    return;
  }
  float depth = depthFade(vDepth, 0.6);
  vec4 tex = texture(uImage, vUV);
  float level = vHeight * ${CONTOUR_LEVELS.toFixed(1)};
  float distToLevel = abs(fract(level + 0.5) - 0.5);
  float contour = (1.0 - smoothstep(0.0, 1.2 * fwidth(level), distToLevel)) * smoothstep(0.02, 0.05, vHeight);
  vec3 lines = uColor * contour * uContours * 0.9 * uFlicker * depth;
  if ( uOpaque > 0.5 ) {
    float a = tex.a * uOpacity * uFlicker;
    fragColor = vec4(holoTint(tex, vShade) * scanline() * depth * a + lines, a) * volumeFade();
    return;
  }
  vec4 holo = holoColor(tex, vShade) * depth;
  fragColor = vec4(holo.rgb + lines, holo.a * uSolidity) * volumeFade();
}`;

const WIRE_FRAGMENT = `#version 300 es
precision highp float;
in float vDepth;
in float vHeight;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
uniform float uWire;
${VOLUME}
out vec4 fragColor;

void main() {
  float land = mix(0.15, 1.0, smoothstep(0.01, 0.05, vHeight));
  float depth = mix(1.0, 0.35, clamp((vDepth + 1.0) * 0.5, 0.0, 1.0));
  float a = uWire * uOpacity * uFlicker * land * depth * volumeFade();
  fragColor = vec4(uColor * (0.8 + 0.6 * vHeight) * a, a * 0.15);
}`;

/**
 * Strokes: each point of a polyline is two vertices, pushed apart across the line in render-texture pixels, so lines
 * keep their on-screen width at any zoom. Neighbouring points give the direction; joins are mitred (clamped).
 */
const STROKE_VERTEX = `
precision highp float;
attribute vec3 aVertexPosition;
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute vec3 aColor;
attribute float aWidth;
attribute float aDistance;
${CAMERA_UNIFORMS}
uniform float uWidth; // half width in layout pixels of a medium stroke
uniform float uWidthScale;
uniform float uPixel; // one device pixel, in layout pixels
varying vec3 vColor;
varying float vEdge;
varying float vHalf;
varying float vDepth;
varying float vDistance;
${PROJECT}
vec2 pixels(vec3 v) {
  return v.xy * ${FOCAL.toFixed(2)} * uCamera.w / (v.z + uCamera.z);
}
void main() {
  vec3 v = view(aVertexPosition);
  vec2 here = pixels(v);
  vec2 back = here - pixels(view(aPrev));
  vec2 ahead = pixels(view(aNext)) - here;
  float lb = length(back);
  float la = length(ahead);
  vec2 d1 = lb > 1e-4 ? back / lb : (la > 1e-4 ? ahead / la : vec2(1.0, 0.0));
  vec2 d2 = la > 1e-4 ? ahead / la : d1;
  vec2 t = d1 + d2;
  t = length(t) > 1e-4 ? normalize(t) : d1;
  vec2 miter = vec2(-t.y, t.x);
  float halfWidth = aWidth * uWidth * uWidthScale;
  float extent = halfWidth + uPixel; // one device pixel more for antialiasing
  float stretch = 1.0 / max(dot(miter, vec2(-d1.y, d1.x)), 0.5);
  vEdge = aSide * extent;
  vHalf = halfWidth;
  vColor = aColor;
  vDistance = aDistance;
  vDepth = v.z;
  float w = v.z + uCamera.z;
  gl_Position = clipFrom((here + miter * aSide * extent * stretch) * w, w, ${STROKE_DEPTH_BIAS.toFixed(4)});
}`;

const STROKE_FRAGMENT = `
precision highp float;
varying vec3 vColor;
varying float vEdge;
varying float vHalf;
varying float vDepth;
varying float vDistance;
uniform float uOpacity;
uniform float uFlicker;
uniform float uPixel;
uniform float uAlpha;
uniform float uSoft; // 1 for the glow pass: fades out across the whole width
uniform float uDash; // dashes per object-space unit along the line; 0 for a solid line
uniform float uDashPhase;
${VOLUME}
void main() {
  float d = abs(vEdge);
  float hard = clamp((vHalf - d) / uPixel + 0.5, 0.0, 1.0);
  float soft = 1.0 - smoothstep(0.0, vHalf + uPixel, d);
  float depth = mix(1.0, 0.6, clamp((vDepth + 1.0) * 0.5, 0.0, 1.0));
  float dash = uDash > 0.0 ? 1.0 - smoothstep(0.55, 0.62, fract(vDistance * uDash - uDashPhase)) : 1.0;
  float a = mix(hard, soft * soft, uSoft) * dash * uAlpha * uOpacity * uFlicker * depth * volumeFade();
  // A hot, whiter core; the glow keeps the ink's own colour.
  vec3 color = mix(vColor, vec3(1.0), 0.3 * (1.0 - uSoft));
  gl_FragColor = vec4(color * a, a * 0.85);
}`;

/**
 * Data motes: specks of light rising through the hologram. Each starts over at a new spot when it reaches the top.
 * Everything is derived from a shared phase, so every client sees the same motes and the CPU does nothing per frame.
 */
const MOTE_VERTEX = `
precision highp float;
attribute vec4 aVertexPosition; // spot seeds (x, z), start offset, size
attribute vec2 aRate;           // rises per period (a whole number), position in the density order (0..1)
${CAMERA_UNIFORMS}
uniform vec2 uExtent;     // footprint half size (x, z)
uniform vec2 uHeight;     // bottom of the rise and its height
uniform float uPhase;     // 0..1 over the animation period
uniform float uDensity;   // fraction of motes shown
uniform float uPointScale;
varying float vRise;
varying float vDepth;
${PROJECT}
float hash(float n) {
  return fract(sin(n) * 43758.5453);
}
void main() {
  if ( aRate.y >= uDensity ) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // Outside the clip volume: not drawn
    gl_PointSize = 1.0;
    return;
  }
  float t = aVertexPosition.z + uPhase * aRate.x;
  vRise = fract(t);
  // The rise count wraps with the period (a whole number of rises), so the spot never jumps mid-rise.
  float cycle = mod(floor(t), aRate.x);
  vec2 spot = vec2(hash(aVertexPosition.x * 91.7 + cycle * 7.13), hash(aVertexPosition.y * 53.3 + cycle * 3.71));
  vec3 p = vec3((spot.x * 2.0 - 1.0) * uExtent.x, uHeight.x + vRise * uHeight.y, (spot.y * 2.0 - 1.0) * uExtent.y);
  gl_Position = project(p);
  gl_PointSize = aVertexPosition.w * uPointScale * uCamera.z / gl_Position.w;
}`;

const MOTE_FRAGMENT = `
precision highp float;
varying float vRise;
varying float vDepth;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
${VOLUME}
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float glow = 1.0 - smoothstep(0.15, 1.0, d);
  float a = glow * (1.0 - vRise) * smoothstep(0.0, 0.08, vRise) * 0.6 * uOpacity * uFlicker * volumeFade();
  // Emitted light: barely any alpha, so motes brighten what is behind them rather than covering it.
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.45) * a, a * 0.2);
}`;

let programs;
function getPrograms() {
  programs ??= {
    panel: PIXI.Program.from(VERTEX, PANEL_FRAGMENT, "vira-holo-panel"),
    disc: PIXI.Program.from(VERTEX, DISC_FRAGMENT, "vira-holo-disc"),
    terrain: PIXI.Program.from(TERRAIN_VERTEX, TERRAIN_FRAGMENT, "vira-holo-terrain"),
    wire: PIXI.Program.from(TERRAIN_VERTEX, WIRE_FRAGMENT, "vira-holo-wire"),
    stroke: PIXI.Program.from(STROKE_VERTEX, STROKE_FRAGMENT, "vira-holo-stroke"),
    mote: PIXI.Program.from(MOTE_VERTEX, MOTE_FRAGMENT, "vira-holo-mote")
  };
  return programs;
}

/** Corner order: far-left, far-right, near-right, near-left. */
function createQuad() {
  return new PIXI.Geometry()
    .addAttribute("aVertexPosition", new Float32Array(12), 3)
    .addAttribute("aTextureCoord", new Float32Array(8), 2)
    .addIndex(new Uint16Array([0, 1, 2, 0, 2, 3]));
}

function setQuad(geometry, hx, y, hz, uvs) {
  geometry.getBuffer("aVertexPosition").update(new Float32Array([-hx, y, hz, hx, y, hz, hx, y, -hz, -hx, y, -hz]));
  geometry.getBuffer("aTextureCoord").update(new Float32Array(uvs));
}

/**
 * An n×n vertex grid spanning [-hx, hx] × [-hz, hz] at height y, as a triangle geometry and a wireframe
 * geometry sharing the same vertex buffers. UV (0, 0) is the far-left corner.
 */
function createGrid(n, hx, y, hz) {
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  for ( let j = 0; j < n; j++ ) {
    for ( let i = 0; i < n; i++ ) {
      const u = i / (n - 1);
      const v = j / (n - 1);
      const k = (j * n) + i;
      positions.set([((u * 2) - 1) * hx, y, (1 - (v * 2)) * hz], k * 3);
      uvs.set([u, v], k * 2);
    }
  }
  const IndexArray = (n * n) > 65535 ? Uint32Array : Uint16Array;
  const triangles = new IndexArray((n - 1) * (n - 1) * 6);
  let t = 0;
  for ( let j = 0; j < n - 1; j++ ) {
    for ( let i = 0; i < n - 1; i++ ) {
      const a = (j * n) + i;
      triangles.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], t);
      t += 6;
    }
  }
  const step = Math.max(1, Math.round((n - 1) / WIRE_LINES));
  const lines = [];
  for ( let j = 0; j < n; j += step ) {
    for ( let i = 0; i < n - 1; i++ ) lines.push((j * n) + i, (j * n) + i + 1);
  }
  for ( let i = 0; i < n; i += step ) {
    for ( let j = 0; j < n - 1; j++ ) lines.push((j * n) + i, ((j + 1) * n) + i);
  }
  const positionBuffer = new PIXI.Buffer(positions, true);
  const uvBuffer = new PIXI.Buffer(uvs, true);
  const build = index => new PIXI.Geometry()
    .addAttribute("aVertexPosition", positionBuffer, 3)
    .addAttribute("aTextureCoord", uvBuffer, 2)
    .addIndex(index);
  return {surface: build(triangles), wire: build(new IndexArray(lines))};
}

/** Mirrors the shaders' depthFade: farther points dim a little. */
function depthFade(depth, far=0.6) {
  return 1 + ((far - 1) * Math.clamp((depth + 1) * 0.5, 0, 1));
}

/** Distance between two 2D segments (0 where they cross). */
function segmentDistance(a, b, c, d) {
  const cross = (o, p, q) => ((p.x - o.x) * (q.y - o.y)) - ((p.y - o.y) * (q.x - o.x));
  const straddles = (s, t) => ((s > 0) && (t < 0)) || ((s < 0) && (t > 0));
  if ( straddles(cross(c, d, a), cross(c, d, b)) && straddles(cross(a, b, c), cross(a, b, d)) ) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = (dx * dx) + (dy * dy);
  const t = length2 ? Math.clamp((((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / length2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + (t * dx)), p.y - (a.y + (t * dy)));
}

/**
 * Read a heightmap's red channel into a small CPU grid. The texture's own image is drawn onto a canvas, so no GPU
 * readback is needed.
 * @param {PIXI.Texture} texture
 * @returns {{width: number, height: number, data: Float32Array}|null}
 */
function readHeights(texture) {
  const source = texture.baseTexture.resource?.source;
  if ( !source ) return null;
  const scale = Math.min(1, HEIGHT_SAMPLES / Math.max(texture.width, texture.height));
  const width = Math.max(2, Math.round(texture.width * scale));
  const height = Math.max(2, Math.round(texture.height * scale));
  const context = new OffscreenCanvas(width, height).getContext("2d", {willReadFrequently: true});
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  for ( let i = 0; i < data.length; i++ ) data[i] = pixels[i * 4] / 255;
  return {width, height, data};
}

/**
 * Mote seeds, the same on every client for a given tile (seeded from its ID), so everyone sees the same motes.
 * @param {string} seed
 */
function createMotes(seed) {
  let state = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const random = () => { // mulberry32
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seeds = new Float32Array(MAX_MOTES * 4);
  const rates = new Float32Array(MAX_MOTES * 2);
  for ( let i = 0; i < MAX_MOTES; i++ ) {
    seeds.set([random(), random(), random(), 0.7 + (random() * 1.3)], i * 4);
    // 4 to 13 rises per 20 s period: 1.5 to 5 seconds to the top, as in the mockup.
    rates.set([4 + Math.floor(random() * 10), (i + 0.5) / MAX_MOTES], i * 2);
  }
  return new PIXI.Geometry()
    .addAttribute("aVertexPosition", seeds, 4)
    .addAttribute("aRate", rates, 2);
}

/** Destroy geometries together with their (possibly shared) GPU buffers, which Geometry#destroy leaves alive. */
function destroyGeometries(...geometries) {
  const buffers = new Set(geometries.flatMap(g => g.buffers));
  for ( const geometry of geometries ) geometry.destroy();
  for ( const buffer of buffers ) buffer.destroy();
}

/**
 * Renders one Tile's hologram into a RenderTexture that replaces the Tile's own texture.
 */
export default class HoloRenderer {
  constructor(tile) {
    this.tile = tile;
    this.renderTexture = PIXI.RenderTexture.create({width: 2, height: 2});
    /**
     * What the tile shows: the render texture placed (trim) over the on-screen part of the full layout (orig).
     * Foundry's sprite meshes honour the trim, so the tile keeps its size, sorting, occlusion and masking.
     */
    this.texture = new PIXI.Texture(this.renderTexture.baseTexture, new PIXI.Rectangle(0, 0, 2, 2),
      new PIXI.Rectangle(0, 0, 2, 2), new PIXI.Rectangle(0, 0, 2, 2));
    /** Layout size, in layout pixels. */
    this.width = 2;
    this.height = 2;
    /** Device pixels per layout pixel in the current render. */
    this.resolution = 1;
    this.fragUniform = new Float32Array([0, 0, 1, 1]);
    /** The on-screen part of the layout, rendered this frame. */
    this.viewport = new PIXI.Rectangle(0, 0, 2, 2);
    this.cameraUniform = new Float32Array(4);
    this.discCameraUniform = new Float32Array(4);
    this.targetUniform = new Float32Array(2);
    this.centerUniform = new Float32Array(2);
    this.volumeUniform = new Float32Array(3);
    this.color = new Float32Array(3);
    this.state = new PIXI.State();
    // Opaque display styles need a depth buffer: surfaces fill it, lines and motes are tested against it.
    this.renderTexture.framebuffer.enableDepth();
    this.depthWriteState = new PIXI.State();
    this.depthWriteState.depthTest = true;
    this.depthReadState = new PIXI.State();
    this.depthReadState.depthTest = true;
    this.depthReadState.depthMask = false;

    const {panel, disc, stroke, mote} = getPrograms();
    this.discGeometry = createQuad();
    setQuad(this.discGeometry, DISC_RADIUS, 0, DISC_RADIUS, [-1, 1, 1, 1, 1, -1, -1, -1]);
    // The projector stays put on the floor: panning and zooming only move the content across and above it.
    this.discShader = new PIXI.Shader(disc, {
      uCamera: this.discCameraUniform, uTarget: new Float32Array(2), uCenter: this.centerUniform, uColor: this.color,
      uOpacity: 1, uFlicker: 1, uDashPhase: 0
    });
    this.panelGeometry = createQuad();
    this.panelShader = new PIXI.Shader(panel, this.#lookUniforms({uPanelShape: new Float32Array([1, 1])}));
    this.panelMesh = new PIXI.Mesh(this.panelGeometry, this.panelShader, this.state);
    this.discMesh = new PIXI.Mesh(this.discGeometry, this.discShader, this.state);
    this.moteGeometry = createMotes(tile.document.id);
    this.moteShader = new PIXI.Shader(mote, {
      uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform, uColor: this.color,
      uVolume: this.volumeUniform, uFrag: this.fragUniform, uExtent: new Float32Array(2), uHeight: new Float32Array(2),
      uPhase: 0, uDensity: 0, uPointScale: 1, uOpacity: 1, uFlicker: 1
    });
    this.moteMesh = new PIXI.Mesh(this.moteGeometry, this.moteShader, this.state, PIXI.DRAW_MODES.POINTS);
    this.stage = new PIXI.Container();
    this.markerLayer = new MarkerLayer();
    const strokeUniforms = {uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform,
      uVolume: this.volumeUniform, uFrag: this.fragUniform};
    this.strokeLayer = new StrokeLayer(stroke, strokeUniforms, this.state);
    this.liveStrokeLayer = new StrokeLayer(stroke, strokeUniforms, this.state);
    this.measureLines = new StrokeLayer(stroke, strokeUniforms, this.state, {dash: MEASURE_DASHES});
    this.liveMeasureLines = new StrokeLayer(stroke, strokeUniforms, this.state, {dash: MEASURE_DASHES});
    this.measureLabels = new MeasureLayer();
    this.stage.addChild(this.discMesh, this.panelMesh);
    this.#addOverlays();
    this.configure();
  }

  /** Unsaved camera shown while someone drags the hologram (locally or on another client). */
  #liveCamera = null;
  #liveUntil = 0;
  /** Another user's camera, which the live camera is eased towards. */
  #liveTarget = null;
  #dragging = false;
  /** Yaw currently on screen, including auto-spin. */
  displayYaw = 0;
  #flicker = 1;
  #flickerTarget = 1;
  #flickerTimer = 0;
  #footprint = "";
  #terrain = null;
  #heightmapSrc = null;
  #heightmap = null;
  /** @type {TextPanel|null} */
  #textPanel = null;
  #linkedImageSrc = null;
  #linkedImage = null;
  /** CPU copy of the heightmap: {width, height, data: Float32Array}. */
  #heights = null;
  #hx = 1;
  #hz = 1;
  /** @type {Map<string, {u: number, v: number}>} Unsaved positions of waypoints being dragged. */
  #liveMarkers = new Map();
  /** Waypoint whose card is open on this client. */
  selectedMarker = null;
  /** The stroke this client is drawing right now. */
  #liveStroke = null;
  #liveStrokeVersion = 0;
  /** The measurement this client is making right now: {points}. */
  #liveMeasure = null;
  #liveMeasureVersion = 0;
  /** @type {Map<string, {stroke: object, until: number}>} Strokes other users are drawing right now, by user. */
  #remoteStrokes = new Map();
  /** @type {Map<string, {points: number[], until: number}>} Measurements other users are making, by user. */
  #remoteMeasures = new Map();
  /** Measurement whose card is open on this client. */
  selectedMeasure = null;
  /** @type {Map<string, number[]>} Unsaved points of measurements whose ends are being moved. */
  #liveMeasurePoints = new Map();
  /** @type {Record<string, Map<string, {item: object, until: number}>>} Items sent to the GM, shown until saved. */
  #pending = {strokes: new Map(), measures: new Map()};
  /** @type {Record<string, Map<string, number>>} Items erased on this client, hidden until the deletion is saved. */
  #erased = {strokes: new Map(), measures: new Map()};
  /** Half width of a medium stroke, in render-texture pixels. */
  #strokeHalfWidth = 1;
  /** UUID of the map shown ("" for a tile on its own settings); undefined before the first configure. */
  #mapKey;
  /** Travel transition in progress: {start, from (content scale)}, or null. */
  #travel = null;
  /** Content opacity factor during a travel transition. */
  #fade = 1;

  /** Strokes, measurements and waypoints go on top of the content, waypoints last. */
  #addOverlays() {
    this.stage.addChild(this.moteMesh, this.strokeLayer.container, this.liveStrokeLayer.container, this.measureLines.container,
      this.liveMeasureLines.container, this.measureLabels.container, this.markerLayer.container);
  }

  #lookUniforms(extra={}) {
    return {
      uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform, uColor: this.color,
      uVolume: this.volumeUniform, uFrag: this.fragUniform, uImage: PIXI.Texture.EMPTY,
      uTint: 0, uOpacity: 1, uSolidity: 1, uScan: 0, uScanDensity: 0, uScanPhase: 0, uFlicker: 1,
      ...extra
    };
  }

  /** Re-read the Tile's flags and size. */
  configure() {
    const data = getHoloData(this.tile.document);
    this.data = data;
    // A saved change supersedes any live preview, except while this client is still dragging.
    if ( !this.#dragging ) {
      // Another user's camera eases onto the saved one rather than jumping to it.
      if ( this.#liveTarget ) {
        this.#liveTarget = {...data.camera};
        this.#liveUntil = performance.now() + 400;
      }
      else this.#liveCamera = null;
      this.#liveMarkers.clear();
      this.#liveMeasurePoints.clear();
    }
    const mapKey = data.map.uuid ?? "";
    if ( (this.#mapKey !== undefined) && (mapKey !== this.#mapKey) ) this.#startTravel(data.map.parent?.uuid === this.#mapKey);
    this.#mapKey = mapKey;
    this.color.set(new PIXI.Color(data.look.color).toRgbArray());
    this.resize();
    const src = (data.mode === "terrain") ? data.terrain.heightmap : null;
    if ( src !== this.#heightmapSrc ) this.#loadHeightmap(src);
    const linkedSrc = data.imageFromTile ? null : data.image;
    if ( linkedSrc !== this.#linkedImageSrc ) this.#loadLinkedImage(linkedSrc);
    if ( data.mode === "text" ) {
      this.#textPanel ??= new TextPanel();
      this.#updateTextPanel();
    }
    else {
      this.#textPanel?.destroy();
      this.#textPanel = null;
    }
    this.#updateGeometry();
  }

  /** Render the sign text for the panel's size at the current resolution (it only re-renders on a change). */
  #updateTextPanel() {
    const {width, height} = this.tile.document;
    const devicePixels = this.resolution * (this.width / width);
    this.#textPanel.update(this.data.text, width * FILL, height * FILL, devicePixels);
  }

  /** The texture shown on the panel or draped over the terrain. */
  get #image() {
    if ( this.#textPanel ) return this.#textPanel.texture;
    if ( !this.data.imageFromTile ) return this.#linkedImage ?? PIXI.Texture.EMPTY;
    return this.tile.texture ?? PIXI.Texture.EMPTY;
  }

  /** A linked tile shows the link's image rather than its own; it is loaded here instead of by Foundry's Tile. */
  async #loadLinkedImage(src) {
    this.#linkedImageSrc = src;
    this.#linkedImage = null;
    if ( !src ) return;
    const loadTexture = foundry.canvas.loadTexture ?? globalThis.loadTexture;
    const texture = await loadTexture(src);
    if ( this.#linkedImageSrc === src ) this.#linkedImage = texture;
  }

  /**
   * Match the layout to the Tile's size.
   * @returns {boolean} Whether the size changed
   */
  resize() {
    const {width, height} = this.tile.document;
    const scale = Math.min(1, MAX_LAYOUT_SIZE / Math.max(width, height, 1));
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    const changed = (this.width !== w) || (this.height !== h);
    if ( changed ) {
      this.width = w;
      this.height = h;
      this.texture.orig = new PIXI.Rectangle(0, 0, w, h);
      this.texture.updateUvs();
    }
    this.centerUniform.set([w / 2, h / 2]);
    this.scanDensity = (height / SCANLINE_SPACING) / h;
    return changed;
  }

  async #loadHeightmap(src) {
    this.#heightmapSrc = src;
    this.#heightmap = null;
    this.#heights = null;
    if ( !src ) return;
    const loadTexture = foundry.canvas.loadTexture ?? globalThis.loadTexture;
    const texture = await loadTexture(src);
    if ( this.#heightmapSrc !== src ) return; // Superseded by a newer request
    if ( !texture ) console.warn(`Vira Holo | Could not load heightmap "${src}"; showing the flat image instead.`);
    this.#heightmap = texture;
    this.#heights = texture ? readHeights(texture) : null;
  }

  /** Terrain height (0..1) at an image position, matching what the GPU draws; 0 without terrain. */
  heightAt(u, v) {
    const heights = this.#heights;
    if ( !heights || !this.#terrain ) return 0;
    const {width, height, data} = heights;
    const x = Math.clamp(u, 0, 1) * (width - 1);
    const y = Math.clamp(v, 0, 1) * (height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0;
    const fy = y - y0;
    const top = (data[(y0 * width) + x0] * (1 - fx)) + (data[(y0 * width) + x1] * fx);
    const bottom = (data[(y1 * width) + x0] * (1 - fx)) + (data[(y1 * width) + x1] * fx);
    return (top * (1 - fy)) + (bottom * fy);
  }

  /**
   * Size the hologram's footprint and (re)build the terrain grid when its resolution or footprint changes.
   * Images and terrain keep their aspect ratio inside a unit circle, so they fit the tile at any rotation.
   * Text panels take the tile's shape and fill it when seen from above.
   */
  #updateGeometry() {
    const {mode, look: {lift}} = this.data;
    const fitRect = mode === "text";
    let hx;
    let hz;
    if ( fitRect ) {
      const longest = Math.max(this.width, this.height);
      hx = this.width / longest;
      hz = this.height / longest;
    } else {
      const image = this.#image;
      const aspect = (image.width && image.height) ? (image.width / image.height) : 1;
      const diagonal = Math.hypot(aspect, 1);
      hx = aspect / diagonal;
      hz = 1 / diagonal;
    }
    this.volumeUniform.set([this.width, this.height, fitRect ? 1 : 0]);
    const radiusPixels = (fitRect ? Math.max(this.width, this.height) : Math.min(this.width, this.height)) / 2;
    this.pixelsPerUnit = radiusPixels * FILL / (FOCAL / BASE_DIST);

    const resolution = Math.clamp(Math.round(this.data.terrain.resolution), 16, 256);
    const key = [hx, hz, lift, mode === "terrain" ? resolution : 0].join();
    if ( key === this.#footprint ) return;
    this.#footprint = key;
    setQuad(this.panelGeometry, hx, lift, hz, [0, 0, 1, 0, 1, 1, 0, 1]);
    this.#hx = hx;
    this.#hz = hz;
    const longest = Math.max(hx, hz);
    this.panelShader.uniforms.uPanelShape.set([hx / longest, hz / longest]);

    this.#destroyTerrain();
    if ( this.data.mode !== "terrain" ) return;
    const {surface, wire} = createGrid(resolution, hx, lift, hz);
    const {terrain, wire: wireProgram} = getPrograms();
    const shape = {
      uHeight: PIXI.Texture.EMPTY, uRelief: 0,
      uTexel: new Float32Array([1 / (resolution - 1), 1 / (resolution - 1)]),
      uCell: new Float32Array([(2 * hx) / (resolution - 1), (2 * hz) / (resolution - 1)])
    };
    const surfaceShader = new PIXI.Shader(terrain, this.#lookUniforms({...shape, uContours: 0, uOpaque: 0,
      uDepthOnly: 0, uDepthBias: 0}));
    const wireShader = new PIXI.Shader(wireProgram, {...this.#lookUniforms(shape), uWire: 0,
      uDepthBias: WIRE_DEPTH_BIAS});
    this.#terrain = {
      geometries: [surface, wire],
      surfaceShader, wireShader,
      meshes: [
        new PIXI.Mesh(surface, surfaceShader, this.state),
        new PIXI.Mesh(wire, wireShader, this.state, PIXI.DRAW_MODES.LINES)
      ]
    };
    this.stage.addChild(...this.#terrain.meshes);
    this.#addOverlays();
  }

  #destroyTerrain() {
    if ( !this.#terrain ) return;
    for ( const mesh of this.#terrain.meshes ) mesh.destroy();
    destroyGeometries(...this.#terrain.geometries);
    this.#terrain = null;
  }

  /**
   * Advance animation state. Every periodic value is derived from the shared server clock and wrapped
   * on the CPU in double precision, so shaders only ever see small numbers and all clients stay in step.
   * @param {number} deltaMS
   */
  update(deltaMS) {
    const {look, terrain} = this.data;
    if ( this.#liveCamera && !this.#dragging && (performance.now() > this.#liveUntil) ) {
      this.#liveCamera = null;
      this.#liveTarget = null;
    }
    if ( this.#liveCamera && this.#liveTarget ) this.#easeCamera(deltaMS);
    const camera = this.camera;
    const seconds = game.time.serverTime / 1000;
    this.displayYaw = (camera.yaw + this.spinPhase(camera.spin)) % TAU;
    const pitch = Math.clamp(camera.pitch, MIN_PITCH, MAX_PITCH);
    const dist = Math.clamp(camera.dist, MIN_DIST, MAX_DIST);
    const scale = this.#updateTravel();
    this.cameraUniform.set([this.displayYaw, pitch, dist, this.pixelsPerUnit * scale]);
    this.discCameraUniform.set([this.displayYaw, pitch, BASE_DIST, this.pixelsPerUnit]);
    this.targetUniform.set([camera.x, camera.z]);

    this.#flickerTimer -= deltaMS;
    if ( this.#flickerTimer <= 0 ) {
      this.#flickerTimer = 40 + (Math.random() * 120);
      const dropout = Math.random() < 0.04 ? 0.5 : 0;
      this.#flickerTarget = 1 - (look.flicker * ((Math.random() * 0.35) + dropout));
    }
    this.#flicker += (this.#flickerTarget - this.#flicker) * 0.35;

    // Heightmaps and linked images are owned by Foundry's texture cache; if one was ever evicted, load it again.
    if ( this.#heightmap?.baseTexture?.destroyed ) this.#loadHeightmap(this.#heightmapSrc);
    if ( this.#linkedImage?.baseTexture?.destroyed ) this.#loadLinkedImage(this.#linkedImageSrc);
    const showTerrain = !!(this.#terrain && this.#heightmap);
    this.panelMesh.visible = !showTerrain;
    if ( this.#terrain ) for ( const mesh of this.#terrain.meshes ) mesh.visible = showTerrain;
    const display = showTerrain ? terrain.display : "xray";
    this.#applyDisplay(display);

    this.discMesh.visible = look.projector;
    const image = this.#image;
    const shaders = showTerrain ? [this.#terrain.surfaceShader, this.#terrain.wireShader] : [this.panelShader];
    for ( const {uniforms} of shaders ) {
      uniforms.uImage = image;
      uniforms.uTint = look.tint;
      uniforms.uOpacity = this.#opacity;
      uniforms.uSolidity = look.solidity;
      uniforms.uScan = look.scanlines;
      uniforms.uScanDensity = this.scanDensity;
      uniforms.uScanPhase = (seconds * 0.8) % 1;
      uniforms.uFlicker = this.#flicker;
    }
    if ( showTerrain ) {
      const {surfaceShader, wireShader} = this.#terrain;
      for ( const {uniforms} of [surfaceShader, wireShader] ) {
        uniforms.uHeight = this.#heightmap;
        uniforms.uRelief = terrain.relief;
      }
      surfaceShader.uniforms.uContours = terrain.contours;
      // A wireframe-only display always shows its wireframe, whatever the overlay setting.
      wireShader.uniforms.uWire = display.startsWith("wire") ? Math.max(terrain.wire, 0.6) : terrain.wire;
    }
    const disc = this.discShader.uniforms;
    disc.uOpacity = look.opacity;
    disc.uFlicker = this.#flicker;
    disc.uDashPhase = (seconds * 0.5) % 1;
    this.#updateMotes(showTerrain, seconds);
    this.#layoutLines(showTerrain);
    this.#layoutMarkers(pitch);
  }

  #updateMotes(showTerrain, seconds) {
    const {look, terrain} = this.data;
    const density = Math.clamp(look.motes, 0, 1);
    this.moteMesh.visible = density > 0;
    if ( !this.moteMesh.visible ) return;
    const uniforms = this.moteShader.uniforms;
    uniforms.uDensity = density;
    uniforms.uPhase = (seconds / MOTE_PERIOD) % 1;
    uniforms.uExtent.set([this.#hx * 0.95, this.#hz * 0.95]);
    // They rise from the floating surface to a little above the highest terrain.
    uniforms.uHeight.set([look.lift, (showTerrain ? terrain.relief : 0) + 0.4]);
    uniforms.uPointScale = (Math.min(this.width, this.height) / 250) * this.resolution;
    uniforms.uOpacity = this.#opacity;
    uniforms.uFlicker = this.#flicker;
  }

  /**
   * Set up a terrain display style, after Blender's viewport: "wireXray" (wireframe, see-through), "wire" (wireframe
   * with hidden lines removed), "xray" (see-through terrain with its wireframe, the hologram look) or "solid"
   * (opaque terrain). In the opaque styles strokes, measurement lines and motes hide behind hills; pins and labels
   * stay on top.
   * @param {string} display
   */
  #applyDisplay(display) {
    const depth = (display === "wire") || (display === "solid");
    if ( this.#terrain ) {
      const [surface, wire] = this.#terrain.meshes;
      surface.visible &&= display !== "wireXray";
      surface.state = depth ? this.depthWriteState : this.state;
      wire.state = depth ? this.depthReadState : this.state;
      this.#terrain.surfaceShader.uniforms.uOpaque = (display === "solid") ? 1 : 0;
      this.#terrain.surfaceShader.uniforms.uDepthOnly = (display === "wire") ? 1 : 0;
    }
    const tested = depth ? this.depthReadState : this.state;
    this.moteMesh.state = tested;
    for ( const layer of [this.strokeLayer, this.liveStrokeLayer, this.measureLines, this.liveMeasureLines] ) {
      layer.setState(tested);
    }
  }

  /** Content opacity: the look's, faded in after travelling to another map. The projector disc doesn't fade. */
  get #opacity() {
    return this.data.look.opacity * this.#fade;
  }

  /**
   * Another map is shown: forget what was in progress on the old one, and let the new one settle into view.
   * @param {boolean} entering   Whether the new map was placed on the old one (else it's the old one's parent)
   */
  #startTravel(entering) {
    this.#travel = {start: performance.now(), from: TRAVEL_SCALE[entering ? "in" : "out"]};
    this.#liveMarkers.clear();
    this.#liveMeasurePoints.clear();
    this.#remoteStrokes.clear();
    this.#remoteMeasures.clear();
    for ( const list of Object.values(this.#pending) ) list.clear();
    for ( const list of Object.values(this.#erased) ) list.clear();
    this.#liveStroke = null;
    this.#liveMeasure = null;
    this.#liveStrokeVersion++;
    this.#liveMeasureVersion++;
  }

  /** @returns {number}   Content scale for this frame (1 when no travel transition is running) */
  #updateTravel() {
    if ( !this.#travel ) return 1;
    const t = (performance.now() - this.#travel.start) / TRAVEL_MS;
    if ( t >= 1 ) {
      this.#travel = null;
      this.#fade = 1;
      return 1;
    }
    const eased = 1 - ((1 - t) ** 3);
    this.#fade = Math.clamp(t * 1.5, 0, 1);
    return this.#travel.from + ((1 - this.#travel.from) * eased);
  }

  /** The camera in effect: a live (unsaved) one while being dragged, otherwise the saved one. */
  get camera() {
    return this.#liveCamera ?? this.data.camera;
  }

  /**
   * Show an unsaved camera until a saved change arrives or `hold` ms pass.
   * @param {object} camera
   * @param {object} [options]
   * @param {number} [options.hold=5000]
   * @param {boolean} [options.smooth=false]  Ease towards it (another user's camera, which arrives in steps)
   */
  setLiveCamera(camera, {hold=5000, smooth=false}={}) {
    const target = {...this.data.camera, ...camera};
    this.#liveUntil = performance.now() + hold;
    if ( !smooth ) {
      this.#liveCamera = target;
      this.#liveTarget = null;
      return;
    }
    this.#liveCamera ??= {...this.data.camera};
    this.#liveTarget = target;
  }

  /** Move the live camera part of the way to another user's, yaw the short way round. */
  #easeCamera(deltaMS) {
    const current = this.#liveCamera;
    const target = this.#liveTarget;
    // A spin toggle keeps the hologram where it is on screen (as on the driver's side): change yaw to match.
    if ( current.spin !== target.spin ) {
      current.yaw += this.spinPhase(current.spin) - this.spinPhase(target.spin);
      current.spin = target.spin;
    }
    const k = 1 - Math.exp(-deltaMS / CAMERA_EASE_MS);
    for ( const key of ["pitch", "dist", "x", "z"] ) current[key] += (target[key] - current[key]) * k;
    const turn = ((((target.yaw - current.yaw) % TAU) + (TAU * 1.5)) % TAU) - (TAU / 2);
    current.yaw += turn * k;
  }

  /** While this client drags, keep its live camera even if other flag updates arrive. */
  set dragging(value) {
    this.#dragging = value;
  }

  /**
   * Auto-spin offset added to the camera yaw, from the shared server clock.
   * @param {number} spin   Radians per second
   */
  spinPhase(spin) {
    return ((game.time.serverTime / 1000) * spin) % TAU;
  }

  /** Scene pixels covered by one footprint unit at the camera target, at the given camera distance. */
  sceneUnitsPerUnit(dist) {
    return this.pixelsPerUnit * (FOCAL / dist) * (this.tile.document.width / this.width);
  }

  /**
   * Work out which part of the hologram is on screen and at what pixel density, and fit the render texture to it.
   * Call before update() and render() each frame.
   * @param {PIXI.Renderer} renderer
   * @returns {boolean}   False when none of the hologram is on screen (nothing to render)
   */
  fitViewport(renderer) {
    const mesh = this.tile.mesh;
    const {width: W, height: H} = this;
    // Map the screen's corners into the mesh's local space (layout pixels around its anchor). The transforms are
    // composed fresh rather than read from worldTransform, which is only updated when the canvas renders (after us),
    // so a pan or zoom this frame would otherwise leave an unrendered strip at the edge.
    const chain = [];
    for ( let node = mesh; node; node = node.parent ) {
      node.transform.updateLocalTransform();
      chain.unshift(node.transform.localTransform);
    }
    const toLocal = point => chain.reduce((p, matrix) => matrix.applyInverse(p, p), new PIXI.Point(point.x, point.y));
    const toScreen = point => chain.reduceRight((p, matrix) => matrix.apply(p, p), new PIXI.Point(point.x, point.y));
    const {width: sw, height: sh} = renderer.screen;
    const corners = [[0, 0], [sw, 0], [0, sh], [sw, sh]].map(([x, y]) => toLocal({x, y}));
    const ax = mesh.anchor.x * W;
    const ay = mesh.anchor.y * H;
    const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x)) + ax) - 1);
    const right = Math.min(W, Math.ceil(Math.max(...corners.map(p => p.x)) + ax) + 1);
    const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y)) + ay) - 1);
    const bottom = Math.min(H, Math.ceil(Math.max(...corners.map(p => p.y)) + ay) + 1);
    if ( (right <= left) || (bottom <= top) ) return false;

    // Device pixels per layout pixel: native, at least enough to supersample a tiny hologram, at most what fits a
    // texture. In quarter-octave steps, since text (labels, signs) is re-rendered whenever it changes.
    const origin = toScreen({x: 0, y: 0});
    const step = toScreen({x: 1, y: 0});
    const native = Math.hypot(step.x - origin.x, step.y - origin.y) * renderer.resolution;
    let resolution = Math.max(native, Math.min(MIN_RENDER_PIXELS / Math.max(W, H), native * MAX_SUPERSAMPLE));
    resolution = 2 ** (Math.ceil(Math.log2(resolution) * 4) / 4);
    const maxSize = Math.min(renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE), MAX_RENDER_SIZE);
    resolution = Math.min(resolution, maxSize / Math.max(right - left, bottom - top));
    this.viewport = new PIXI.Rectangle(left, top, right - left, bottom - top);
    this.fragUniform.set([left, top, 1 / resolution, 1 / resolution]);
    if ( this.resolution !== resolution ) {
      this.resolution = resolution;
      if ( this.#textPanel ) this.#updateTextPanel();
    }
    this.#allocate(Math.ceil((right - left) * resolution), Math.ceil((bottom - top) * resolution));
    return true;
  }

  /**
   * Size the render texture's used area to w×h device pixels. The shown texture maps that area (its frame, in
   * device pixels) onto the on-screen part of the layout (its trim, in layout pixels). The memory behind it only
   * grows in steps, or shrinks once it is far too big, so panning and zooming rarely reallocate it.
   */
  #allocate(w, h) {
    const base = this.renderTexture.baseTexture;
    const grow = (base.width < w) || (base.height < h);
    const shrink = (base.width * base.height) > (4 * Math.max(w * h, 512 * 512));
    // Frames must fit the base texture whenever it changes size: set them after growing, before shrinking.
    if ( !grow ) this.#setFrames(w, h);
    const bucket = n => Math.ceil(n / 256) * 256;
    if ( grow ) base.resize(Math.max(base.width, bucket(w)), Math.max(base.height, bucket(h)));
    else if ( shrink ) base.resize(bucket(w), bucket(h));
    if ( grow ) this.#setFrames(w, h);
  }

  #setFrames(w, h) {
    const rt = this.renderTexture;
    rt.frame = new PIXI.Rectangle(0, 0, w, h);
    rt.updateUvs();
    const texture = this.texture;
    texture.frame = new PIXI.Rectangle(0, 0, w, h);
    texture.trim = this.viewport.clone();
    texture.updateUvs();
  }

  /** @param {PIXI.Renderer} renderer */
  render(renderer) {
    this.#updateGeometry();
    const {x, y} = this.viewport;
    const r = this.resolution;
    const transform = new PIXI.Matrix(r, 0, 0, r, -x * r, -y * r);
    // The clear only resets depth while depth writes are on, which the last mesh drawn may have turned off.
    renderer.state.set(this.state);
    renderer.render(this.stage, {renderTexture: this.renderTexture, clear: true, transform});
  }

  /* -------------------------------------------- */
  /*  Waypoints and picking                       */
  /* -------------------------------------------- */

  /**
   * The waypoints as currently shown, including unsaved drags, followed by portals: one for each map placed on the
   * map shown (`portal` is its UUID; only GMs may drag them).
   */
  get markers() {
    const {look, map} = this.data;
    const portals = map.children.map(({uuid, id, name, u, v}) => ({id, u, v, label: name, glyph: "portal",
      color: look.color, size: 3, locked: !game.user.isGM, portal: uuid}));
    return [...this.data.annotations.markers, ...portals].map(m => {
      const live = this.#liveMarkers.get(m.id);
      return live ? {...m, ...live} : m;
    });
  }

  /** @param {string} id @param {{u: number, v: number}|null} position */
  setLiveMarker(id, position) {
    if ( position ) this.#liveMarkers.set(id, position);
    else this.#liveMarkers.delete(id);
  }

  /**
   * Show the stroke being drawn on this client (call again after adding points), or stop showing it.
   * @param {object|null} stroke
   */
  setLiveStroke(stroke) {
    this.#liveStroke = stroke;
    this.#liveStrokeVersion++;
  }

  /**
   * Show the measurement being made on this client (call again after moving its end), or stop showing it.
   * @param {{points: number[]}|null} measure
   */
  setLiveMeasure(measure) {
    this.#liveMeasure = measure;
    this.#liveMeasureVersion++;
  }

  /**
   * An annotation as this client shows it (strokes and measurements still on their way to the GM included).
   * @param {"markers"|"strokes"|"measures"} list
   * @param {string} id
   * @returns {object|null}
   */
  annotation(list, id) {
    const items = (list === "markers") ? this.data.annotations.markers : this.#shown(list);
    return items.find(item => item.id === id) ?? null;
  }

  /**
   * Show a measurement with moved ends until the save arrives, or stop showing it that way.
   * @param {string} id
   * @param {number[]|null} points
   */
  setLiveMeasurePoints(id, points) {
    if ( points ) this.#liveMeasurePoints.set(id, points);
    else this.#liveMeasurePoints.delete(id);
  }

  /**
   * Show what another user is doing mid-drag (see socket.mjs for the shapes; everything is sanitized there).
   * @param {string} userId
   * @param {object} preview
   */
  applyPreview(userId, preview) {
    const until = performance.now() + REMOTE_PREVIEW_MS;
    switch ( preview.kind ) {
      case "marker":
        this.setLiveMarker(preview.id, {u: preview.u, v: preview.v});
        break;
      case "measurePoints":
        this.setLiveMeasurePoints(preview.id, preview.points);
        break;
      case "stroke": {
        // Strokes arrive in pieces: each continues where the last ended.
        const {id, color, width, from, points} = preview;
        const entry = (from === 0) ? {stroke: {id, color, width, points: []}} : this.#remoteStrokes.get(userId);
        if ( !entry || (entry.stroke.id !== id) || (entry.stroke.points.length !== from) ) return;
        entry.stroke.points.push(...points);
        entry.until = until;
        this.#remoteStrokes.set(userId, entry);
        this.#liveStrokeVersion++;
        break;
      }
      case "strokeEnd":
        this.#remoteStrokes.delete(userId);
        this.#liveStrokeVersion++;
        if ( preview.stroke ) this.addPending("strokes", preview.stroke);
        break;
      case "measure":
        this.#remoteMeasures.set(userId, {points: preview.points, until});
        this.#liveMeasureVersion++;
        break;
      case "measureEnd":
        this.#remoteMeasures.delete(userId);
        this.#liveMeasureVersion++;
        if ( preview.measure ) this.addPending("measures", preview.measure);
        break;
    }
  }

  /** Forget other users' previews they stopped updating (they left, or lost the connection). */
  #expirePreviews() {
    const now = performance.now();
    for ( const [map, bump] of [[this.#remoteStrokes, () => this.#liveStrokeVersion++],
      [this.#remoteMeasures, () => this.#liveMeasureVersion++]] ) {
      for ( const [userId, {until}] of map ) {
        if ( now <= until ) continue;
        map.delete(userId);
        bump();
      }
    }
  }

  /** This client's measurement in progress and other users', with "live" IDs (never picked). */
  get #liveMeasures() {
    const own = this.#liveMeasure ? [{id: "live", ...this.#liveMeasure}] : [];
    return [...own, ...Array.from(this.#remoteMeasures, ([userId, {points}]) => ({id: `live:${userId}`, points}))];
  }

  /**
   * Keep showing a new stroke or measurement until the GM's save brings it back (or it never does).
   * @param {"strokes"|"measures"} list
   * @param {object} item
   */
  addPending(list, item) {
    this.#pending[list].set(item.id, {item, until: performance.now() + PENDING_MS});
  }

  /**
   * Hide a stroke or measurement right away while its deletion is on the way to the GM.
   * @param {"strokes"|"measures"} list
   * @param {string} id
   */
  hide(list, id) {
    this.#erased[list].set(id, performance.now() + PENDING_MS);
  }

  /**
   * Saved items of a list plus this client's pending ones, minus the ones it erased. Forgets pending and erased
   * entries once the saved data has caught up with them or they time out.
   * @param {"strokes"|"measures"} list
   */
  #shown(list) {
    const saved = this.data.annotations[list];
    const pending = this.#pending[list];
    const erased = this.#erased[list];
    const now = performance.now();
    const ids = new Set(saved.map(s => s.id));
    for ( const [id, {until}] of pending ) {
      if ( ids.has(id) || (now > until) ) pending.delete(id);
    }
    for ( const [id, until] of erased ) {
      if ( (!ids.has(id) && !pending.has(id)) || (now > until) ) erased.delete(id);
    }
    return [...saved, ...Array.from(pending.values(), p => p.item)].filter(s => !erased.has(s.id));
  }

  /**
   * Shown strokes and measurements whose line passes within `radius` of the segment a→b (render-texture pixels),
   * e.g. an eraser's sweep.
   * @param {{x: number, y: number}} a
   * @param {{x: number, y: number}} b
   * @param {number} radius
   * @returns {{list: string, id: string}[]}
   */
  annotationsAlong(a, b, radius) {
    const project = this.#projector();
    const found = [];
    for ( const [list, layer] of [["strokes", this.strokeLayer], ["measures", this.measureLines]] ) {
      for ( const {id, width, positions} of layer.lines ) {
        if ( this.#erased[list].has(id) ) continue;
        const reach = radius + (this.#strokeHalfWidth * width);
        let previous = null;
        for ( const position of positions ) {
          const point = project(position);
          if ( point && previous && (this.#volumeAlpha(point) > 0.05)
            && (segmentDistance(a, b, previous, point) <= reach) ) {
            found.push({list, id});
            break;
          }
          previous = point;
        }
      }
    }
    return found;
  }

  /** Strokes and measurement lines, rebuilt into meshes only when they or the surface change. */
  #layoutLines(showTerrain) {
    const {look, terrain} = this.data;
    // On terrain, segments are split per grid cell so lines follow the relief.
    const onTerrain = showTerrain && !!this.#heights;
    const step = onTerrain ? 1 / (Math.clamp(Math.round(terrain.resolution), 16, 256) - 1) : 0;
    const shape = [this.#hx, this.#hz, look.lift, onTerrain ? terrain.relief : 0, step].join();
    const surface = (u, v) => this.#surfacePosition(u, v);
    const key = items => `${shape}|${items.map(s => s.id).join()}`;
    const asLine = ({id, points}) => ({id, points, color: MEASURE_INK, width: 1});

    this.#expirePreviews();
    const strokes = this.#shown("strokes");
    this.strokeLayer.sync(strokes, key(strokes), surface, step);
    const liveStrokes = [...(this.#liveStroke ? [this.#liveStroke] : []),
      ...Array.from(this.#remoteStrokes.values(), entry => entry.stroke)];
    this.liveStrokeLayer.sync(liveStrokes, `${shape}|${this.#liveStrokeVersion}`, surface, step);
    // Measurements are straight lines between their two surface points, through hills rather than over them.
    const live = this.#liveMeasurePoints;
    const measures = this.#shown("measures").map(m => (live.has(m.id) ? {...m, points: live.get(m.id)} : m));
    const moved = Array.from(live, ([id, points]) => `${id}:${points.join()}`).join();
    this.measureLines.sync(measures.map(asLine), `${key(measures)}|${moved}`, surface, 0);
    this.liveMeasureLines.sync(this.#liveMeasures.map(asLine), `${shape}|${this.#liveMeasureVersion}`, surface, 0);

    this.#strokeHalfWidth = Math.clamp(Math.min(this.width, this.height) * 0.0022, 1, 5);
    const style = {
      opacity: this.#opacity, flicker: this.#flicker, width: this.#strokeHalfWidth, pixel: 1 / this.resolution,
      dashPhase: ((game.time.serverTime / 1000) * 1.5) % 1
    };
    for ( const layer of [this.strokeLayer, this.liveStrokeLayer, this.measureLines, this.liveMeasureLines] ) {
      layer.update(style);
    }
    this.#layoutMeasureLabels(measures);
  }

  /** Endpoint dots and distance labels, placed with the camera as drawn this frame. */
  #layoutMeasureLabels(measures) {
    const size = Math.clamp(Math.min(this.width, this.height) * 0.016, 6, 24);
    const all = [...measures, ...this.#liveMeasures];
    const labels = all.map(({id, points}) => ({id, text: this.#distanceLabel(points)}));
    const sprites = this.measureLabels.sync(labels, size, this.selectedMeasure, this.resolution);
    const project = this.#projector();
    for ( const {id, points: [ua, va, ub, vb]} of all ) {
      const sprite = sprites.get(id);
      const from = this.#surfacePosition(ua, va);
      const to = this.#surfacePosition(ub, vb);
      const a = project(from);
      const b = project(to);
      const middle = project({x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2});
      if ( !a || !b || !middle ) {
        sprite.container.visible = false;
        continue;
      }
      const alpha = this.#opacity * this.#flicker * this.#volumeAlpha(middle) * depthFade(middle.depth);
      sprite.place(a, b, middle, alpha);
    }
  }

  #distanceLabel(points) {
    const metres = this.measureLength(points);
    if ( metres === null ) return game.i18n.localize("VIRAHOLO.Measure.NoScale");
    return formatDistance(metres, this.data.scale.unit);
  }

  /**
   * Distance between two image points in metres, from the hologram's scale; null without one. Measured across the
   * map (as on a paper map), not along the terrain's slopes.
   * @param {number[]} points   [ua, va, ub, vb]
   * @returns {number|null}
   */
  measureLength([ua, va, ub, vb]) {
    const {distance, unit, axis} = this.data.scale;
    if ( !(distance > 0) || !UNITS[unit] ) return null;
    const metresPerUnit = (distance * UNITS[unit].metres) / ((axis === "height") ? 2 * this.#hz : 2 * this.#hx);
    return metresPerUnit * Math.hypot((ub - ua) * 2 * this.#hx, (vb - va) * 2 * this.#hz);
  }

  /**
   * The scale that makes a measurement the given length, keeping the current axis.
   * @param {number[]} points
   * @param {number} distance
   * @param {string} unit
   * @returns {object|null}   Null for a measurement of no length
   */
  scaleFrom([ua, va, ub, vb], distance, unit) {
    const length = Math.hypot((ub - ua) * 2 * this.#hx, (vb - va) * 2 * this.#hz);
    if ( !(length > 0) || !(distance > 0) ) return null;
    const axis = this.data.scale.axis;
    const extent = (axis === "height") ? 2 * this.#hz : 2 * this.#hx;
    return {distance: Math.round((distance * extent / length) * 1000) / 1000, unit, axis};
  }

  /** The measurement whose label is under a render-texture point, if any. */
  measureAt(point) {
    const id = this.measureLabels.hitTest(point.x, point.y);
    return id?.startsWith("live") ? null : id;
  }

  /**
   * The measurement end nearest a render-texture point, within reach of its dot.
   * @returns {{id: string, end: 0|1}|null}
   */
  measureEndAt(point) {
    const hit = this.measureLabels.endAt(point.x, point.y);
    return hit?.id.startsWith("live") ? null : hit;
  }

  /** Where a measurement's label is drawn (its top centre), in render-texture pixels. */
  measureTip(id) {
    const bounds = this.measureLabels.get(id)?.bounds;
    return bounds ? {x: bounds.x + (bounds.width / 2), y: bounds.y} : null;
  }

  /** Object-space position of an image point on the hologram's surface. */
  #surfacePosition(u, v) {
    const {lift} = this.data.look;
    const relief = this.data.terrain.relief;
    return {
      x: ((u * 2) - 1) * this.#hx,
      y: lift + (this.heightAt(u, v) * relief),
      z: (1 - (v * 2)) * this.#hz
    };
  }

  /**
   * Project an object-space point into render-texture pixels with the camera as last drawn (same maths as PROJECT).
   * @returns {{x: number, y: number, depth: number}|null}   Null behind the camera
   */
  #project(point) {
    return this.#projector()(point);
  }

  /** #project with the camera's trigonometry worked out once, for projecting many points. */
  #projector() {
    const [yaw, pitch, dist, ppu] = this.cameraUniform;
    const [tx, tz] = this.targetUniform;
    const [cx, cy] = this.centerUniform;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    return ({x: px, y: py, z: pz}) => {
      px -= tx;
      pz -= tz;
      const x = (px * cosY) + (pz * sinY);
      const z1 = (pz * cosY) - (px * sinY);
      const y = (py * cosP) + (z1 * sinP);
      const z = (z1 * cosP) - (py * sinP);
      const w = z + dist;
      if ( w <= 0.05 ) return null;
      const s = (FOCAL * ppu) / w;
      return {x: cx + (x * s), y: cy - (y * s), depth: z};
    };
  }

  /** How visible a render-texture point is inside the projection area (matches the shaders' volumeFade). */
  #volumeAlpha({x, y}) {
    const [w, h, rect] = this.volumeUniform;
    const qx = Math.abs(((x / w) * 2) - 1);
    const qy = Math.abs(((y / h) * 2) - 1);
    const d = rect ? Math.max(qx, qy) : Math.hypot(qx, qy);
    const t = Math.clamp((d - 0.88) / 0.12, 0, 1);
    return 1 - (t * t * (3 - (2 * t)));
  }

  #layoutMarkers(pitch) {
    const {look} = this.data;
    const markers = this.markers;
    const size = Math.clamp(Math.min(this.width, this.height) * 0.022, 7, 32);
    this.markerLayer.sync(markers, {size, labels: look.labels, selected: this.selectedMarker,
      resolution: this.resolution});
    for ( const marker of markers ) {
      const surface = this.#surfacePosition(marker.u, marker.v);
      const base = this.#project(surface);
      const head = this.#project({...surface, y: surface.y + STEM_HEIGHT});
      const sprite = this.markerLayer.get(marker.id);
      if ( !base || !head ) {
        sprite.container.visible = false;
        continue;
      }
      const alpha = this.#opacity * this.#flicker * this.#volumeAlpha(base) * depthFade(base.depth);
      sprite.place(base, head, Math.sin(pitch), alpha);
    }
  }

  /**
   * Convert a canvas point to render-texture pixels of this hologram.
   * @param {{x: number, y: number}} point
   */
  toTexturePoint(point) {
    const mesh = this.tile.mesh;
    const local = mesh.toLocal(new PIXI.Point(point.x, point.y), canvas.stage);
    return {x: local.x + (mesh.anchor.x * this.width), y: local.y + (mesh.anchor.y * this.height)};
  }

  /**
   * Convert render-texture pixels of this hologram to a canvas point.
   * @param {{x: number, y: number}} point
   */
  toCanvasPoint(point) {
    const mesh = this.tile.mesh;
    const local = new PIXI.Point(point.x - (mesh.anchor.x * this.width), point.y - (mesh.anchor.y * this.height));
    return canvas.stage.toLocal(local, mesh);
  }

  /** Camera target that centres the projection on an image position. */
  surfaceTarget(u, v) {
    return {x: Math.clamp(((u * 2) - 1) * this.#hx, -1, 1), z: Math.clamp((1 - (v * 2)) * this.#hz, -1, 1)};
  }

  /** The waypoint under a render-texture point, if any. */
  markerAt(point) {
    return this.markerLayer.hitTest(point.x, point.y);
  }

  /** Where a waypoint's head is drawn, in render-texture pixels. */
  markerTip(id) {
    return this.markerLayer.get(id)?.tip ?? null;
  }

  /**
   * The image position (u, v) of the hologram surface under a render-texture point: the inverse of #project along
   * the camera ray, intersected with the panel or marched against the terrain.
   * @returns {{u: number, v: number}|null}
   */
  surfaceAt({x: sx, y: sy}) {
    const [yaw, pitch, dist, ppu] = this.cameraUniform;
    const [tx, tz] = this.targetUniform;
    const [cx, cy] = this.centerUniform;
    const a = (sx - cx) / (FOCAL * ppu);
    const b = -(sy - cy) / (FOCAL * ppu);
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    // Camera-space ray: (a·t, b·t, t − dist) for t > 0; rotate back into object space.
    const at = t => {
      const x = a * t;
      const y = b * t;
      const z = t - dist;
      const py = (y * cosP) - (z * sinP);
      const z1 = (y * sinP) + (z * cosP);
      return {x: (x * cosY) - (z1 * sinY) + tx, y: py, z: (x * sinY) + (z1 * cosY) + tz};
    };
    const toUV = p => ({u: ((p.x / this.#hx) + 1) / 2, v: (1 - (p.z / this.#hz)) / 2});
    const inside = ({u, v}) => (u >= 0) && (u <= 1) && (v >= 0) && (v <= 1);
    // Height of the ray above a horizontal plane at height h changes linearly with t.
    const slope = (b * cosP) - sinP;
    const tAtHeight = h => (h - (dist * sinP)) / slope;
    const {lift} = this.data.look;
    if ( Math.abs(slope) < 1e-6 ) return null;

    if ( !this.#terrain || !this.#heights ) {
      const t = tAtHeight(lift);
      if ( t <= 0 ) return null;
      const uv = toUV(at(t));
      return inside(uv) ? uv : null;
    }

    const relief = this.data.terrain.relief;
    const above = t => {
      const p = at(t);
      const uv = toUV(p);
      return p.y - (lift + (inside(uv) ? this.heightAt(uv.u, uv.v) * relief : 0));
    };
    const tTop = Math.max(tAtHeight(lift + relief), 1e-3);
    const tBottom = tAtHeight(lift);
    if ( tBottom <= 0 ) return null;
    const steps = 96;
    let previous = tTop;
    for ( let i = 1; i <= steps; i++ ) {
      const t = tTop + (((tBottom - tTop) * i) / steps);
      if ( above(t) > 0 ) {
        previous = t;
        continue;
      }
      let lo = previous;
      let hi = t;
      for ( let j = 0; j < 12; j++ ) {
        const mid = (lo + hi) / 2;
        if ( above(mid) > 0 ) lo = mid;
        else hi = mid;
      }
      const uv = toUV(at(hi));
      return inside(uv) ? uv : null;
    }
    return null;
  }

  destroy() {
    this.#heightmapSrc = null;
    this.#linkedImageSrc = null;
    this.#textPanel?.destroy();
    this.#destroyTerrain();
    this.markerLayer.destroy();
    this.strokeLayer.destroy();
    this.liveStrokeLayer.destroy();
    this.measureLines.destroy();
    this.liveMeasureLines.destroy();
    this.measureLabels.destroy();
    this.moteMesh.destroy();
    this.stage.destroy({children: true});
    destroyGeometries(this.discGeometry, this.panelGeometry, this.moteGeometry);
    this.texture.destroy(false);
    this.renderTexture.destroy(true);
  }
}
