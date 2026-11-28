import AreaLayer from "./area-layer.mjs";
import {MARKING_RANGES, MEASURE_INK, SIGN_PANELS, SIGN_SCROLLS, SIGN_TILT_RANGE, effectiveDisplay, UNITS, formatArea,
  formatDistance, getHoloData} from "./data.mjs";
import MarkerLayer, {MAX_SCALE} from "./marker-layer.mjs";
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
/** Stem height per pin size tier, as a fraction of STEM_HEIGHT. */
const STEM_TIERS = {1: 0.6, 2: 0.8, 3: 1};
/** Smallest perspective scale pins and labels are drawn at (the largest is MAX_SCALE). */
const MIN_SCALE = 0.75;
/** How long everything labels are laid out around must hold still before they're laid out afresh. */
const STILL_MS = 200;
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
/** Switching on or off takes this long. */
const POWER_MS = 900;
/**
 * Sign text is redrawn for a new resolution only once the zoom has stayed put this long (redrawing every sign at each
 * zoom step stuttered), and only when it needs to be sharper or is more than TEXT_OVERSHARP times too sharp.
 */
const TEXT_SETTLE_MS = 250;
const TEXT_OVERSHARP = 2;
/** A tile needs at least this many grid squares across for the table's hole. */
const TABLE_HOLE_SQUARES = 3;
/** The off table's radius (object units), its hole and its switch-on pad as fractions of it, and its texture size. */
const TABLE_RADIUS = DISC_RADIUS * 0.97;
const TABLE_HOLE = 0.3;
const TABLE_PAD = 0.14;
const TABLE_TEXTURE_SIZE = 1024;
/** Most grid squares along either side, so a tiny square size can't build millions of lines. */
const MAX_GRID_SQUARES = 200;
const CONTOUR_LEVELS = 12;
/** Height (0-1) at which the heightmap counts as land: the coastline of an island, drawn in the wireframe styles. */
const COAST_HEIGHT = 0.012;  // ~3/255: heights are read back as 8-bit
/** World units a height of 1.0 rises per unit of the `relief` setting: keeps useful reliefs around 0.2-1.5. */
const RELIEF_SCALE = 0.1;
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
/** How long a ping lasts, and how many may show at once. */
const PING_MS = 1500;
const MAX_PINGS = 12;
/** How long the view takes to pan from the spot a map was left at to the centre of its parent (tiles that recentre). */
const RECENTER_MS = 1100;
/** Content scale a travel starts from: a map entered grows into view, a parent shrinks into it. */
const TRAVEL_SCALE = {in: 0.3, out: 2.5};
/** Height of a sign panel's foot above the floor, in object units. */
const SIGN_FOOT = 0.17;
/**
 * How much bigger a sign's top edge looks than its foot from the default camera when it leans back 60°: the
 * perspective that stands it up. This sets the panel's length up its plane, which other tilts keep.
 */
const SIGN_PERSPECTIVE = 1.22;
/**
 * Sign projectors (`text.base`), in object units: top height, half width (from the panel's half width) and half
 * depth, corner radius, lens distance in front of the panel's foot, lens offset from the centre (towards the panel),
 * lens half width (from the projector's half width), shadow strength, and the style number the shaders know it by.
 */
const SIGN_BASES = Object.freeze({
  bar: {height: 0.045, width: hx => Math.min(Math.max(hx * 0.55, 0.16), hx * 0.95), depth: 0.08, radius: 0.03,
    lens: 0.17, lensOffset: 0.025, lensWidth: w => w - 0.055, shadow: 1, style: 0},
  puck: {height: 0.04, width: hx => Math.min(0.065, hx * 0.95), depth: 0.065, radius: 0.065,
    lens: 0.16, lensOffset: 0, lensWidth: () => 0.004, shadow: 1, style: 1},
  flush: {height: 0.001, width: hx => Math.min(Math.max(hx * 0.5, 0.12), hx * 0.95), depth: 0.03, radius: 0.03,
    lens: 0.15, lensOffset: 0, lensWidth: w => w - 0.06, shadow: 0, style: 2}
});
/** Light rays per page of a sign without a panel. */
const SIGN_RAYS = 72;
/** How long pages take to change. */
const SIGN_PAGE_CHANGE_S = 0.9;
/** One scanline per this many scene pixels along a sign's panel. */
const SIGN_SCANLINE_SPACING = 9;
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

// Scanlines run across the screen unless a shader defines SCAN_Y first (signs run them along their tilted plane).
#ifndef SCAN_Y
#define SCAN_Y (holoPixel().y * uScanDensity)
#endif
float scanline() {
  return 1.0 - uScan * 0.6 * (0.5 + 0.5 * sin((SCAN_Y + uScanPhase) * 6.2831853));
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
uniform sampler2D uAreas;  // areas drawn over the image (premultiplied)
void main() {
  vec4 holo = holoColor(texture2D(uImage, vUV), 1.0) * depthFade(vDepth, 0.7);
  vec2 edge = min(vUV, 1.0 - vUV) * uPanelShape;
  float frame = smoothstep(0.012, 0.0, min(edge.x, edge.y));
  vec4 area = texture2D(uAreas, vUV) * uOpacity * uFlicker;
  // Premultiplied output: alpha below brightness makes the hologram partly additive when composited.
  gl_FragColor = vec4(holo.rgb + uColor * frame * 0.8 * uFlicker + area.rgb, holo.a * uSolidity + frame * 0.2 + area.a * 0.5)
    * volumeFade();
}`;

const DISC_VERTEX = `#version 300 es
precision highp float;
in vec3 aVertexPosition;
in vec2 aTextureCoord;
${CAMERA_UNIFORMS}
out vec2 vUV;
out float vDepth;
${PROJECT}
void main() {
  vUV = aTextureCoord;
  gl_Position = project(aVertexPosition);
}`;

// The two circles are one device pixel thin whatever the camera does (fwidth), like the terrain wireframe.
const DISC_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
uniform float uDashPhase;
uniform vec4 uParts; // ring, dashed ring, glow, north marker: 1 = shown
out vec4 fragColor;

float line(float r, float at) {
  return 1.0 - smoothstep(0.0, 1.3 * fwidth(r), abs(r - at));
}

// A "^" between the two circles at the top of the image (+y in the disc's UV), which is north.
float north(vec2 uv) {
  vec2 p = uv - vec2(0.0, 0.9575);
  float s = 0.0245 / 0.028;
  float d = abs(p.y - (0.01225 - abs(p.x) * s)) / sqrt(1.0 + s * s);
  return step(abs(p.x), 0.028) * (1.0 - smoothstep(0.0, 1.8 * fwidth(d), d));
}

void main() {
  float r = length(vUV);
  if ( r > 1.0 ) discard;
  float angle = atan(vUV.y, vUV.x) / 6.2831853 + 0.5;
  float ring = line(r, 0.93);
  float dashes = step(0.55, fract(angle * 64.0 + uDashPhase)) * line(r, 0.985);
  float pool = 0.12 * (1.0 - smoothstep(0.2, 0.93, r));
  float a = (ring * 0.85 * uParts.x + dashes * 0.85 * uParts.y + pool * uParts.z + north(vUV) * 0.9 * uParts.w) * uOpacity * uFlicker;
  fragColor = vec4(uColor * a, a * 0.25);
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
uniform float uLinesOnly; // 1: only the contour and coast lines (the wireframe styles; drawn by a mesh of their own)
uniform float uDepthOnly; // 1: only fill the depth buffer, so lines behind hills are hidden
uniform sampler2D uAreas;  // areas drawn over the image (premultiplied)
out vec4 fragColor;

void main() {
  if ( uDepthOnly > 0.5 ) {
    fragColor = vec4(0.0);
    return;
  }
  float depth = depthFade(vDepth, 0.6);
  float level = vHeight * ${CONTOUR_LEVELS.toFixed(1)};
  float distToLevel = abs(fract(level + 0.5) - 0.5);
  float contour = (1.0 - smoothstep(0.0, 1.2 * fwidth(level), distToLevel)) * smoothstep(0.008, 0.02, vHeight);
  vec3 lines = uColor * contour * uContours * 0.9 * uFlicker * depth;
  // Areas lie on the surface in every style (the wireframe styles draw them with the lines).
  vec4 area = texture(uAreas, vUV) * uOpacity * uFlicker * depth;
  if ( uLinesOnly > 0.5 ) {
    float coast = 1.0 - smoothstep(0.0, 1.5 * fwidth(vHeight), abs(vHeight - ${COAST_HEIGHT.toFixed(3)}));
    lines = lines * 1.6 + uColor * coast * 1.1 * uOpacity * uFlicker * depth;
    fragColor = (vec4(lines, 0.3 * max(lines.r, max(lines.g, lines.b))) + vec4(area.rgb, area.a * 0.5)) * volumeFade();
    return;
  }
  vec4 tex = texture(uImage, vUV);
  if ( uOpaque > 0.5 ) {
    float a = tex.a * uOpacity * uFlicker;
    fragColor = vec4(holoTint(tex, vShade) * scanline() * depth * a + lines + area.rgb, a) * volumeFade();
    return;
  }
  vec4 holo = holoColor(tex, vShade) * depth;
  fragColor = vec4(holo.rgb + lines + area.rgb, holo.a * uSolidity + area.a * 0.5) * volumeFade();
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
  float land = mix(0.15, 1.0, smoothstep(0.004, 0.02, vHeight));
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
attribute float aCap; // -1/1: pushed out past the line's start/end into a round cap; 0 along the line
${CAMERA_UNIFORMS}
uniform float uWidth; // half width in layout pixels of a medium stroke
uniform float uWidthScale;
uniform float uPixel; // one device pixel, in layout pixels
varying vec3 vColor;
varying float vEdge;
varying float vHalf;
varying float vDepth;
varying float vDistance;
varying float vAlong;
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
  vAlong = abs(aCap) * extent;
  vHalf = halfWidth;
  vColor = aColor;
  vDistance = aDistance;
  vDepth = v.z;
  float w = v.z + uCamera.z;
  gl_Position = clipFrom((here + miter * aSide * extent * stretch + t * aCap * extent) * w, w, ${STROKE_DEPTH_BIAS.toFixed(4)});
}`;

const STROKE_FRAGMENT = `
precision highp float;
varying vec3 vColor;
varying float vEdge;
varying float vHalf;
varying float vDepth;
varying float vDistance;
varying float vAlong;
uniform float uOpacity;
uniform float uFlicker;
uniform float uPixel;
uniform float uAlpha;
uniform float uSoft; // 1 for the glow pass: fades out across the whole width
uniform float uDash; // dashes per object-space unit along the line; 0 for a solid line
uniform float uDashPhase;
${VOLUME}
void main() {
  float d = length(vec2(vEdge, vAlong)); // round at the ends
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

/*
 * Signs (text mode): a physical projector base on the floor, a fan of light rising from its lens, and the text on a
 * panel leaning back above it. The base, the floor under it and the beam get a vec3 aTextureCoord of their own.
 */
const SIGN_PART_VERTEX = `#version 300 es
precision highp float;
in vec3 aVertexPosition;
in vec3 aTextureCoord;
${CAMERA_UNIFORMS}
out vec3 vPart;
out float vDepth;
${PROJECT}
void main() {
  vPart = aTextureCoord;
  gl_Position = project(aVertexPosition);
}`;

const SDF = `
float roundedBox(vec2 p, vec2 size, float radius) {
  vec2 q = abs(p) - size + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
// 1 within width of d = 0, fading over about a device pixel.
float hairline(float d, float width) {
  return 1.0 - smoothstep(width, width + 1.5 * fwidth(d), abs(d));
}`;

const SIGN_PANEL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
in float vDepth;
#define SCAN_Y (vUV.y * uScanDensity)
${HOLO_LOOK}
${SDF}
uniform sampler2D uImage2; // the next page, while pages change
uniform vec4 uWindow;      // share of the page texture shown (u, v) and the scroll offset (u, v)
uniform vec4 uWindow2;
uniform float uChange;     // progress of a page change, 0 (none) to 1
uniform vec2 uPages;       // page count, and the page shown (fractional while changing)
uniform float uManual;     // 1: paged by hand, with arrows either side of the page dots
uniform float uStyle;      // panel style: 0 frame, 1 none, 2 screen
uniform float uScroll;     // 0 none, 1 up, 2 sideways
uniform vec2 uPanelShape;  // panel extents along its plane, longer side = 1
uniform float uReveal;     // how far up from its foot the panel has materialised (switching on)
uniform float uSweep;      // height of the bright band sweeping up the panel (outside 0..1: none)
out vec4 fragColor;

vec4 page(sampler2D image, vec4 window) {
  vec2 uv = window.zw + vUV * window.xy;
  if ( uScroll > 1.5 ) uv.x = fract(uv.x);
  else if ( uScroll > 0.5 ) uv.y = fract(uv.y);
  return texture(image, uv);
}

float hash(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}

void main() {
  float up = 1.0 - vUV.y;
  float reach = uReveal * 1.1;
  float shown = 1.0 - smoothstep(reach - 0.08, reach, up);
  vec4 tex = page(uImage, uWindow);
  // Without a panel (style "none"), flashes only light what is on it, so its shape never shows.
  float bare = (uStyle > 0.5 && uStyle < 1.5) ? 1.0 : 0.0;
  float content = tex.a;
  // The next page rises from the foot in ragged bands of rows, behind a bright edge.
  float changing = 0.0;
  if ( uChange > 0.0 ) {
    float rows = floor(vUV.y * 36.0);
    float line = up + (hash(rows) - 0.5) * 0.14;
    float front = uChange * 1.3 - 0.15;
    vec4 next = page(uImage2, uWindow2);
    content = max(content, next.a);
    tex = mix(tex, next, step(line, front));
    changing = exp(-pow((line - front) * 22.0, 2.0));
  }
  float flashes = mix(1.0, smoothstep(0.0, 0.4, content), bare);
  // Scrolling content fades in and out at the panel's edges.
  if ( uScroll > 0.5 ) {
    float along = (uScroll > 1.5) ? vUV.x : vUV.y;
    tex *= smoothstep(0.0, 0.07, along) * smoothstep(0.0, 0.07, 1.0 - along);
  }
  vec4 holo = holoColor(tex, 1.0) * depthFade(vDepth, 0.85);

  vec2 edge = min(vUV, 1.0 - vUV) * uPanelShape;
  float lit = exp(-up * 4.0); // most light where the beam reaches the panel
  float foot = exp(-up * uPanelShape.y * 60.0);
  float frame = 0.0;
  float bracket = 0.0;
  float fill = 0.0;
  float clip = 1.0;
  if ( uStyle < 0.5 ) {
    frame = hairline(min(edge.x, edge.y), 0.0);
    float arm = 0.07;
    bracket = max(hairline(edge.x, 0.005) * step(edge.y, arm), hairline(edge.y, 0.005) * step(edge.x, arm));
    fill = 0.035 + 0.1 * lit;
  } else if ( uStyle > 1.5 ) {
    // A screen: a solid, rounded pane with a bright border.
    float d = roundedBox((vUV - 0.5) * uPanelShape, uPanelShape * 0.5, 0.03);
    clip = 1.0 - smoothstep(-fwidth(d), fwidth(d), d);
    frame = hairline(d + 0.006, 0.003) * 1.3;
    fill = 0.26 + 0.08 * lit;
    foot *= 0.4;
  } else {
    foot = 0.0;
  }
  fill *= scanline();

  // One dot per page along the foot, the one shown lit.
  float dots = 0.0;
  if ( uPages.x > 1.5 ) {
    const float spacing = 0.032;
    vec2 p = vec2((vUV.x - 0.5) * uPanelShape.x, up * uPanelShape.y);
    float i = floor(p.x / spacing + uPages.x * 0.5);
    if ( (i >= 0.0) && (i < uPages.x) ) {
      float d = length(p - vec2((i + 0.5 - uPages.x * 0.5) * spacing, 0.02)) - 0.0065;
      float away = abs(i - uPages.y);
      float on = 1.0 - clamp(min(away, uPages.x - away), 0.0, 1.0);
      dots = (1.0 - smoothstep(-fwidth(d), fwidth(d), d)) * mix(0.3, 1.0, on);
    }
    if ( uManual > 0.5 ) {
      // Chevrons either side of the dots: click the sign's left or right half to turn back or on.
      float reach = (uPages.x * 0.5 + 1.0) * spacing;
      vec2 q = vec2(abs(p.x) - reach, abs(p.y - 0.02));
      vec2 a = vec2(-0.004, 0.009);
      vec2 ba = vec2(0.009, -0.009);
      float h = clamp(dot(q - a, ba) / dot(ba, ba), 0.0, 1.0);
      float d = length(q - a - ba * h) - 0.0016;
      dots = max(dots, (1.0 - smoothstep(-fwidth(d), fwidth(d), d)) * 0.9);
    }
  }

  float band = exp(-pow((up - uSweep) * 12.0, 2.0));
  float pane = 1.0 - bare;
  float glow = uOpacity * uFlicker;
  vec3 rgb = holo.rgb * (1.0 + band * 0.8) + uColor * glow * (fill * 0.6 + frame * 0.6 + bracket + band * 0.07 * pane
    + foot * 0.5 + dots * 0.9 + changing * 0.6 * flashes);
  float a = holo.a * uSolidity + glow * (fill * 0.5 + frame * 0.2 + bracket * 0.35 + band * 0.03 * pane + dots * 0.3);
  // While materialising, a bright edge runs up the panel ahead of what is shown.
  float front = exp(-pow((up - reach + 0.04) * 28.0, 2.0)) * smoothstep(0.0, 0.05, uReveal) * (1.0 - step(1.0, uReveal)) * flashes;
  fragColor = (vec4(rgb, a) * shown * clip + vec4(uColor * front * glow * 1.4, front * glow * 0.2)) * volumeFade();
}`;

const SIGN_BEAM_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vPart; // across the face (0..1), from the lens (0) to the panel (1), the face's strength
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
uniform float uPhase; // 0..1, wrapping
${VOLUME}
out vec4 fragColor;

void main() {
  float s = vPart.x;
  float t = vPart.y;
  float fall = pow(1.0 - t, 1.5);
  float rays = 0.6 + 0.4 * sin(s * 61.0 + 2.0 * sin(s * 13.0 + uPhase * 6.2831853));
  float edges = smoothstep(0.82, 1.0, abs(s * 2.0 - 1.0));
  // Pulses of light travelling up from the lens to the panel.
  float pulse = exp(-pow((t - fract(uPhase * 4.0)) * 9.0, 2.0)) + exp(-pow((t - fract(uPhase * 4.0 + 0.5)) * 9.0, 2.0));
  float a = vPart.z * (fall * (0.75 * rays + 0.8 * edges) + 0.06 + 0.35 * pulse * (1.0 - t) * rays);
  // It leaves the lens softly (the lens's own glow covers the start), so it doesn't light the projector in a hard band.
  a *= smoothstep(0.0, 0.12, t) * uOpacity * uFlicker * volumeFade();
  fragColor = vec4(uColor * a, 0.0); // Light only: it brightens what's behind it
}`;

// Without a panel to light, a sign's light is a bundle of rays from the lens to its lines of text and images.
const SIGN_RAY_VERTEX = `#version 300 es
precision highp float;
in vec3 aVertexPosition;
// Across the ray (0..1), from the lens (0) to its target (1), its own random number (plus 1 for a broad, faint ray of
// haze rather than a thin, bright one), and its page.
in vec4 aTextureCoord;
${CAMERA_UNIFORMS}
out vec3 vPart;
out float vPage;
out float vDepth;
${PROJECT}
void main() {
  vPart = aTextureCoord.xyz;
  vPage = aTextureCoord.w;
  gl_Position = project(aVertexPosition);
}`;

const SIGN_RAY_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vPart;
in float vPage;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
uniform float uPhase; // 0..1, wrapping
uniform vec3 uPages;  // page shown, next page, page change progress
${VOLUME}
out vec4 fragColor;

void main() {
  float shown = ((abs(vPage - uPages.x) < 0.5) ? 1.0 - uPages.z : 0.0) + ((abs(vPage - uPages.y) < 0.5) ? uPages.z : 0.0);
  if ( shown <= 0.0 ) discard;
  float t = vPart.y;
  float broad = step(1.0, vPart.z);
  float k = fract(vPart.z);
  float across = 1.0 - abs(vPart.x * 2.0 - 1.0);
  // Soft from the lens, strongest on the way, dissolving into what it lights.
  float along = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.75, 1.0, t));
  float twinkle = 0.55 + 0.45 * sin((uPhase * 7.0 + k) * 6.2831853);
  float pulse = exp(-pow((t - fract(uPhase * 4.0 + k)) * 10.0, 2.0));
  float strength = mix(0.16 + 0.22 * pulse, 0.14 + 0.05 * pulse, broad);
  float a = strength * across * across * along * twinkle * shown * uOpacity * uFlicker * volumeFade();
  fragColor = vec4(uColor * a, 0.0);
}`;

const SIGN_FLOOR_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vPart; // floor position (x, z)
uniform vec3 uColor;
uniform float uOpacity; // of the light; the shadow is the projector's own
uniform float uFlicker;
uniform vec4 uBase;     // projector centre (x, z) and half size
uniform float uRadius;  // projector corner radius
uniform float uShadow;  // projector shadow strength (none when flush with the floor)
uniform vec4 uPanel;    // panel half width, foot z, top z, lens z
uniform float uUnder;   // light under the panel (none when the panel isn't shown, so its shape doesn't show)
uniform float uLens;    // lens half width
${SDF}
${VOLUME}
out vec4 fragColor;

void main() {
  vec2 p = vPart.xy;
  float dBase = roundedBox(p - uBase.xy, uBase.zw, uRadius);
  float shadow = uShadow * (0.45 * (1.0 - smoothstep(-0.01, 0.035, dBase)) + 0.12 * (1.0 - smoothstep(0.0, 0.1, dBase)));
  float zHalf = (uPanel.z - uPanel.y) * 0.5;
  float dPanel = roundedBox(p - vec2(0.0, uPanel.y + zHalf), vec2(uPanel.x, zHalf), 0.04);
  float under = (1.0 - smoothstep(-0.15, 0.12, dPanel)) * mix(1.0, 0.3, clamp((p.y - uPanel.y) / (2.0 * zHalf), 0.0, 1.0));
  // The beam lights the floor between the lens and the panel, fading in past the lens.
  float dLens = length(vec2(max(abs(p.x) - uLens, 0.0), p.y - uPanel.w));
  float spill = exp(-dLens * 12.0) * smoothstep(uPanel.w - 0.02, uPanel.w + 0.08, p.y);
  float light = (0.09 * under * uUnder + 0.16 * spill) * uOpacity * uFlicker;
  fragColor = vec4(uColor * light, shadow) * volumeFade();
}`;

const SIGN_BASE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vPart; // position on the projector's top from its centre (x, z towards the panel)
uniform vec3 uColor;
uniform vec2 uSize;      // half size
uniform float uRadius;   // corner radius
uniform float uStyle;    // 0 bar, 1 puck, 2 flush with the floor
uniform vec2 uLensAt;    // lens z (from the centre) and half width
uniform float uLensGlow; // 0 (off) to 1, flicker included
uniform float uPower;    // 0 (off) to 1
uniform float uPhase;    // 0..1, wrapping every 12 s
${SDF}
${VOLUME}
out vec4 fragColor;

float body(vec2 p) {
  return roundedBox(p, uSize, uRadius);
}
float spot(vec2 p, vec2 at, float r) {
  float d = length(p - at) - r;
  return 1.0 - smoothstep(-fwidth(d), fwidth(d), d);
}

void main() {
  vec2 p = vPart.xy;
  float d = body(p);
  float aa = fwidth(d);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  if ( inside <= 0.0 ) discard;
  const float e = 0.003;
  vec2 normal = normalize(vec2(body(p + vec2(e, 0.0)) - body(p - vec2(e, 0.0)), body(p + vec2(0.0, e)) - body(p - vec2(0.0, e))) + 1e-6);
  float lit = dot(normal, normalize(vec2(-0.55, 0.85))); // light from the top left, as in most maps
  float depth = -d;
  bool flush = uStyle > 1.5;

  // Dark gunmetal, a little lighter towards the back, with a lit bevel, a rim and an inset panel line. Flush with
  // the floor it is only a trim with a sunken edge.
  vec3 rgb = vec3(0.115, 0.125, 0.15) * (0.92 + 0.14 * (p.y / uSize.y));
  if ( flush ) rgb += (1.0 - smoothstep(0.0, 2.0 * aa + 0.002, depth)) * (0.1 - 0.12 * lit);
  else {
    rgb += (1.0 - smoothstep(0.0, 0.02, depth)) * lit * 0.16;
    rgb += (1.0 - smoothstep(0.0, 2.0 * aa + 0.002, depth)) * max(lit, 0.0) * 0.22;
    rgb *= 1.0 - 0.5 * hairline(depth - 0.016, 0.0015);
  }

  // Vents at the front left of the bar.
  if ( uStyle < 0.5 ) {
    vec2 v = p - vec2(-uSize.x + 0.075, -uSize.y + 0.04);
    float vents = step(abs(v.y), 0.012) * step(abs(v.x), 0.045) * (1.0 - smoothstep(0.25, 0.45, abs(fract(v.x / 0.016) - 0.5)));
    rgb *= 1.0 - 0.55 * vents;
  }

  // The lens: a dark slot with a glowing core that lights the metal around it.
  vec2 l = p - vec2(0.0, uLensAt.x);
  float slot = roundedBox(l, vec2(uLensAt.y, 0.016), 0.016);
  float slotAA = fwidth(slot);
  rgb = mix(rgb, vec3(0.025, 0.03, 0.035), 1.0 - smoothstep(-slotAA, slotAA, slot - 0.007));
  rgb += uColor * 0.1 * (1.0 - smoothstep(-slotAA, slotAA, abs(slot - 0.007) - 0.0015)); // the slot's bright lip
  float core = 1.0 - smoothstep(-slotAA, slotAA, slot);
  float hot = exp(-length(vec2(max(abs(l.x) - uLensAt.y + 0.02, 0.0), l.y)) * 150.0);
  rgb += uColor * uLensGlow * (core * (0.55 + 1.3 * hot) + exp(-max(slot, 0.0) * 55.0) * 0.28);

  // Status lights: steady and blinking in the hologram colour, or a slow red standby.
  vec3 standby = vec3(1.0, 0.16, 0.1) * (0.7 + 0.3 * sin(uPhase * 6.2831853 * 6.0));
  vec3 on = uColor * 1.4;
  float blink = step(0.35, fract(uPhase * 21.0));
  if ( uStyle > 0.5 && uStyle < 1.5 ) {
    // The puck: a ring of lights round the lens, chasing when on.
    float ring = 0.0;
    float r = uSize.x * 0.7;
    for ( int k = 0; k < 8; k++ ) {
      float angle = float(k) / 8.0 * 6.2831853;
      float chase = fract(uPhase * 6.0 - float(k) / 8.0);
      float level = mix(k == 0 ? 1.0 : 0.0, 0.25 + 0.75 * exp(-chase * 5.0), uPower);
      ring += level * spot(p, vec2(sin(angle), -cos(angle)) * r, 0.0055);
    }
    rgb += mix(standby, on, uPower) * ring;
  } else {
    vec2 led = flush ? vec2(uSize.x - 0.02, 0.0) : vec2(uSize.x - 0.05, -uSize.y + 0.04);
    rgb += mix(standby, on, uPower) * spot(p, led, flush ? 0.006 : 0.008);
    if ( !flush ) rgb += on * uPower * blink * spot(p, led - vec2(0.03, 0.0), 0.008);
  }

  fragColor = vec4(rgb, 1.0) * inside * volumeFade();
}`;

let programs;
function getPrograms() {
  programs ??= {
    panel: PIXI.Program.from(VERTEX, PANEL_FRAGMENT, "vira-holo-panel"),
    disc: PIXI.Program.from(DISC_VERTEX, DISC_FRAGMENT, "vira-holo-disc"),
    terrain: PIXI.Program.from(TERRAIN_VERTEX, TERRAIN_FRAGMENT, "vira-holo-terrain"),
    wire: PIXI.Program.from(TERRAIN_VERTEX, WIRE_FRAGMENT, "vira-holo-wire"),
    stroke: PIXI.Program.from(STROKE_VERTEX, STROKE_FRAGMENT, "vira-holo-stroke"),
    mote: PIXI.Program.from(MOTE_VERTEX, MOTE_FRAGMENT, "vira-holo-mote"),
    signPanel: PIXI.Program.from(DISC_VERTEX, SIGN_PANEL_FRAGMENT, "vira-holo-sign-panel"),
    signBeam: PIXI.Program.from(SIGN_PART_VERTEX, SIGN_BEAM_FRAGMENT, "vira-holo-sign-beam"),
    signFloor: PIXI.Program.from(SIGN_PART_VERTEX, SIGN_FLOOR_FRAGMENT, "vira-holo-sign-floor"),
    signBase: PIXI.Program.from(SIGN_PART_VERTEX, SIGN_BASE_FRAGMENT, "vira-holo-sign-base"),
    signRays: PIXI.Program.from(SIGN_RAY_VERTEX, SIGN_RAY_FRAGMENT, "vira-holo-sign-rays")
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

/** A geometry of object-space points with a vec3 aTextureCoord each (see SIGN_PART_VERTEX). */
function createPartGeometry(positions, coords, index) {
  return new PIXI.Geometry()
    .addAttribute("aVertexPosition", new Float32Array(positions), 3)
    .addAttribute("aTextureCoord", new Float32Array(coords), 3)
    .addIndex(new Uint16Array(index));
}

/** A horizontal rectangle at height y whose aTextureCoord is (x, z) relative to `origin` (x, z). */
function createFloorRect(x0, x1, z0, z1, y, [ox, oz]=[0, 0]) {
  const corners = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  return createPartGeometry(corners.flatMap(([x, z]) => [x, y, z]), corners.flatMap(([x, z]) => [x - ox, z - oz, 0]),
    [0, 1, 2, 0, 2, 3]);
}

function setQuad(geometry, hx, y, hz, uvs) {
  geometry.getBuffer("aVertexPosition").update(new Float32Array([-hx, y, hz, hx, y, hz, hx, y, -hz, -hx, y, -hz]));
  geometry.getBuffer("aTextureCoord").update(new Float32Array(uvs));
}

/**
 * An n×n vertex grid spanning [-hx, hx] × [-hz, hz] at height y, as a triangle geometry and a wireframe
 * geometry sharing the same vertex buffers. UV (0, 0) is the far-left corner.
 */
function createGrid(n, hx, y, hz, squares=null) {
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
  const positionBuffer = new PIXI.Buffer(positions, true);
  const uvBuffer = new PIXI.Buffer(uvs, true);
  const build = (index, position=positionBuffer, uv=uvBuffer) => new PIXI.Geometry()
    .addAttribute("aVertexPosition", position, 3)
    .addAttribute("aTextureCoord", uv, 2)
    .addIndex(index);
  if ( squares ) return {surface: build(triangles), wire: squaresWire(n, hx, y, hz, squares)};
  const step = Math.max(1, Math.round((n - 1) / WIRE_LINES));
  const lines = [];
  for ( let j = 0; j < n; j += step ) {
    for ( let i = 0; i < n - 1; i++ ) lines.push((j * n) + i, (j * n) + i + 1);
  }
  for ( let i = 0; i < n; i += step ) {
    for ( let j = 0; j < n - 1; j++ ) lines.push((j * n) + i, ((j + 1) * n) + i);
  }
  return {surface: build(triangles), wire: build(new IndexArray(lines))};
}

/**
 * Wireframe lines at the edges of squares of a set size (not tied to the surface's vertices): `across` squares
 * along the image's width and `down` along its height, each line sampled `n` times so it follows the relief.
 */
function squaresWire(n, hx, y, hz, {across, down}) {
  const us = Array.from({length: Math.floor(across) + 1}, (_, k) => k / across);
  const vs = Array.from({length: Math.floor(down) + 1}, (_, k) => k / down);
  if ( us.at(-1) < 1 ) us.push(1);
  if ( vs.at(-1) < 1 ) vs.push(1);
  const count = (us.length + vs.length) * n;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const index = new Uint32Array((us.length + vs.length) * (n - 1) * 2);
  let k = 0;
  let t = 0;
  const addLine = point => {
    for ( let s = 0; s < n; s++, k++ ) {
      const [u, v] = point(s / (n - 1));
      positions.set([((u * 2) - 1) * hx, y, (1 - (v * 2)) * hz], k * 3);
      uvs.set([u, v], k * 2);
      if ( s < n - 1 ) {
        index.set([k, k + 1], t);
        t += 2;
      }
    }
  };
  for ( const u of us ) addLine(s => [u, s]);
  for ( const v of vs ) addLine(s => [s, v]);
  return new PIXI.Geometry()
    .addAttribute("aVertexPosition", new PIXI.Buffer(positions, true), 3)
    .addAttribute("aTextureCoord", new PIXI.Buffer(uvs, true), 2)
    .addIndex(index);
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
    /** Pins and the labels of measurements and areas, drawn far to near: each sets its zIndex to minus its depth. */
    this.billboards = new PIXI.Container();
    this.billboards.sortableChildren = true;
    this.areaLayer = new AreaLayer(this.billboards);
    this.discGeometry = createQuad();
    setQuad(this.discGeometry, DISC_RADIUS, 0, DISC_RADIUS, [-1, 1, 1, 1, 1, -1, -1, -1]);
    // The projector stays put on the floor: panning and zooming only move the content across and above it.
    this.discShader = new PIXI.Shader(disc, {
      uCamera: this.discCameraUniform, uTarget: new Float32Array(2), uCenter: this.centerUniform, uColor: this.color,
      uOpacity: 1, uFlicker: 1, uDashPhase: 0, uParts: new Float32Array(4)
    });
    this.panelGeometry = createQuad();
    this.panelShader = new PIXI.Shader(panel, this.#lookUniforms({uPanelShape: new Float32Array([1, 1])}));
    this.signPanelShader = new PIXI.Shader(getPrograms().signPanel, this.#lookUniforms({
      uPanelShape: new Float32Array([1, 1]), uReveal: 1, uSweep: -1, uImage2: PIXI.Texture.EMPTY,
      uWindow: new Float32Array([1, 1, 0, 0]), uWindow2: new Float32Array([1, 1, 0, 0]), uChange: 0,
      uPages: new Float32Array([1, 0]), uManual: 0, uStyle: 0, uScroll: 0
    }));
    this.panelMesh = new PIXI.Mesh(this.panelGeometry, this.panelShader, this.state);
    // The off table is the panel's hologram look on a fixed top-down camera, with a drawn texture as its image.
    this.offCameraUniform = new Float32Array([0, Math.PI / 2, BASE_DIST, 1]);
    this.tableGeometry = createQuad();
    setQuad(this.tableGeometry, TABLE_RADIUS / 0.97, 0, TABLE_RADIUS / 0.97, [0, 0, 1, 0, 1, 1, 0, 1]);
    this.tableShader = new PIXI.Shader(panel, this.#lookUniforms({
      uPanelShape: new Float32Array([1000, 1000]), uCamera: this.offCameraUniform, uTarget: new Float32Array(2), uTint: 1,
      uAreas: PIXI.Texture.EMPTY
    }));
    this.tableMesh = new PIXI.Mesh(this.tableGeometry, this.tableShader, this.state);
    this.tableMesh.visible = false;
    this.discMesh = new PIXI.Mesh(this.discGeometry, this.discShader, this.state);
    this.moteGeometry = createMotes(tile.document.id);
    this.moteShader = new PIXI.Shader(mote, {
      uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform, uColor: this.color,
      uVolume: this.volumeUniform, uFrag: this.fragUniform, uExtent: new Float32Array(2), uHeight: new Float32Array(2),
      uPhase: 0, uDensity: 0, uPointScale: 1, uOpacity: 1, uFlicker: 1
    });
    this.moteMesh = new PIXI.Mesh(this.moteGeometry, this.moteShader, this.state, PIXI.DRAW_MODES.POINTS);
    this.stage = new PIXI.Container();
    this.markerLayer = new MarkerLayer(this.billboards);
    this.pingGraphics = new PIXI.Graphics();
    this.offGraphics = new PIXI.Graphics();
    const strokeUniforms = {uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform,
      uVolume: this.volumeUniform, uFrag: this.fragUniform};
    this.strokeLayer = new StrokeLayer(stroke, strokeUniforms, this.state);
    this.liveStrokeLayer = new StrokeLayer(stroke, strokeUniforms, this.state);
    this.measureLines = new StrokeLayer(stroke, strokeUniforms, this.state, {dash: MEASURE_DASHES});
    this.liveMeasureLines = new StrokeLayer(stroke, strokeUniforms, this.state, {dash: MEASURE_DASHES});
    this.measureLabels = new MeasureLayer(this.billboards);
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
  /** The resolution the sign text was last drawn for, and when to redraw it for the current one (0: no need). */
  #textResolution = null;
  #textDue = 0;
  /** A sign's layout (see #layoutSign) and its meshes; null unless in text mode. */
  #sign = null;
  /** Pages paged by hand: the page last fully shown, and the turn to another in progress ({from, to, start}). */
  #settledPage = null;
  #flip = null;
  /** The pages shown this frame: the current one, the one rising in and how far (0..1). */
  #pageState = {current: 0, next: 0, change: 0};
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
  /** Waypoint under the pointer on this client: its label shows on top. */
  hoveredMarker = null;
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
  #pending = {strokes: new Map(), measures: new Map(), areas: new Map()};
  /** @type {Record<string, Map<string, number>>} Items erased on this client, hidden until the deletion is saved. */
  #erased = {strokes: new Map(), measures: new Map(), areas: new Map()};
  /** The area this client is drawing right now: {shape, points, color}. */
  #liveArea = null;
  /** Area whose card is open on this client. */
  selectedArea = null;
  /** Half width of a medium stroke, in render-texture pixels. */
  #strokeHalfWidth = 1;
  /** UUID of the map shown ("" for a tile on its own settings); undefined before the first configure. */
  #mapKey;
  /** Travel transition in progress: {start, from (content scale)}, or null. */
  #travel = null;
  /** Going up with `recenterUp`: the spot (u, v) the old map was at, which the view eases from. */
  #recenter = null;
  /** @type {{u: number, v: number, color: number, start: number}[]} Pings on show. */
  #pings = [];
  /** Content opacity factor during a travel transition. */
  #fade = 1;
  /** 0 (off) to 1 (on), moving towards `data.powered`; null before the first configure. */
  #power = null;
  /** The eased #power: scales and fades the content. */
  #powerEase = 1;
  /** Where the switch-on spot is in render-texture pixels while off: {x, y, rx, ry}. */
  #powerSpot = null;
  /** The table texture and whether it was drawn with a hole; built when first needed. */
  #tableTexture = null;
  #tableHoleDrawn = null;

  /** Strokes and measurement lines go on top of the content, then waypoints and labels. */
  #addOverlays() {
    this.stage.addChild(this.moteMesh, this.strokeLayer.container, this.liveStrokeLayer.container, this.measureLines.container,
      this.liveMeasureLines.container, this.billboards, this.tableMesh, this.pingGraphics, this.offGraphics);
  }

  #lookUniforms(extra={}) {
    return {
      uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform, uColor: this.color,
      uVolume: this.volumeUniform, uFrag: this.fragUniform, uImage: PIXI.Texture.EMPTY,
      uTint: 0, uOpacity: 1, uSolidity: 1, uScan: 0, uScanDensity: 0, uScanPhase: 0, uFlicker: 1,
      uAreas: this.areaLayer.overlay,
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
    if ( (this.#mapKey !== undefined) && (mapKey !== this.#mapKey) ) {
      this.#startTravel(data.map.parent?.uuid === this.#mapKey);
      const left = data.recenterUp ? data.map.children.find(c => c.uuid === this.#mapKey) : null;
      this.#recenter = left ? {start: performance.now(), u: left.u, v: left.v} : null;
    }
    this.#mapKey = mapKey;
    this.#power ??= data.powered ? 1 : 0;
    this.color.set(new PIXI.Color(data.look.color).toRgbArray());
    this.resize();
    const src = (data.mode === "terrain") ? data.terrain.heightmap : null;
    if ( src !== this.#heightmapSrc ) this.#loadHeightmap(src);
    const linkedSrc = data.imageFromTile ? null : data.image;
    if ( linkedSrc !== this.#linkedImageSrc ) this.#loadLinkedImage(linkedSrc);
    if ( data.mode === "text" ) this.#textPanel ??= new TextPanel();
    else {
      this.#textPanel?.destroy();
      this.#textPanel = null;
    }
    this.#updateGeometry();
    if ( this.#textPanel ) this.#updateTextPanel();
  }

  /**
   * Render the sign text for the panel's size along its plane, at the current resolution (it only re-renders on a
   * change). Seen from above the panel is foreshortened, so the texture only needs that much height.
   */
  #updateTextPanel() {
    const sign = this.#sign;
    if ( !sign ) return;
    this.#textResolution = this.resolution;
    this.#textDue = 0;
    const scenePerLayout = this.tile.document.width / this.width;
    const scale = y => this.pixelsPerUnit * (FOCAL / (BASE_DIST - y)) * scenePerLayout;
    const middle = scale((sign.foot + sign.top) / 2);
    // The top edge is nearest the camera and shown largest: render for that.
    const devicePixels = this.resolution * (scale(sign.top) / middle) / scenePerLayout;
    this.#textPanel.update(this.data.text, 2 * this.#hx * middle, sign.slant * middle, devicePixels, sign.cos);
  }

  /** The texture shown on the panel or draped over the terrain. */
  get #image() {
    if ( this.#textPanel ) return this.#textPanel.pages[0]?.texture ?? PIXI.Texture.EMPTY;
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
    const sign = (mode === "text") ? this.#layoutSign() : null;
    let hx;
    let hz;
    if ( sign ) {
      hx = sign.hx;
      hz = sign.slant / 2;
      // The whole sign as seen from above (`half` its projected height) fills the tile.
      this.pixelsPerUnit = (this.height / 2) * FILL / (FOCAL / BASE_DIST) / sign.half;
    } else {
      const image = this.#image;
      const aspect = (image.width && image.height) ? (image.width / image.height) : 1;
      const diagonal = Math.hypot(aspect, 1);
      hx = aspect / diagonal;
      hz = 1 / diagonal;
      this.pixelsPerUnit = (Math.min(this.width, this.height) / 2) * FILL / (FOCAL / BASE_DIST);
    }
    this.volumeUniform.set([this.width, this.height, sign ? 1 : 0]);

    const resolution = Math.clamp(Math.round(this.data.terrain.resolution), 16, 1024);
    const squares = mode === "terrain" ? this.#gridSquares(hx, hz) : null;
    const key = [mode, hx, hz, lift, mode === "terrain" ? resolution : 0, squares?.across, squares?.down, sign?.key].join();
    if ( key === this.#footprint ) return;
    this.#footprint = key;
    this.#hx = hx;
    this.#hz = hz;
    this.#destroySign();
    this.#sign = sign;
    if ( sign ) this.#buildSign();
    else setQuad(this.panelGeometry, hx, lift, hz, [0, 0, 1, 0, 1, 1, 0, 1]);
    const longest = Math.max(hx, hz);
    this.panelMesh.shader.uniforms.uPanelShape.set([hx / longest, hz / longest]);

    this.#destroyTerrain();
    if ( this.data.mode !== "terrain" ) return;
    const {surface, wire} = createGrid(resolution, hx, lift, hz, squares);
    const {terrain, wire: wireProgram} = getPrograms();
    const shape = {
      uHeight: PIXI.Texture.EMPTY, uRelief: 0,
      uTexel: new Float32Array([1 / (resolution - 1), 1 / (resolution - 1)]),
      uCell: new Float32Array([(2 * hx) / (resolution - 1), (2 * hz) / (resolution - 1)])
    };
    const surfaceShader = new PIXI.Shader(terrain, this.#lookUniforms({...shape, uContours: 0, uOpaque: 0,
      uLinesOnly: 0, uDepthOnly: 0, uDepthBias: 0}));
    // The lines of the wireframe styles are a pass of their own: drawn with the surface they would show through hills.
    const linesShader = new PIXI.Shader(terrain, this.#lookUniforms({...shape, uContours: 0, uOpaque: 0,
      uLinesOnly: 1, uDepthOnly: 0, uDepthBias: WIRE_DEPTH_BIAS}));
    const wireShader = new PIXI.Shader(wireProgram, {...this.#lookUniforms(shape), uWire: 0,
      uDepthBias: WIRE_DEPTH_BIAS});
    this.#terrain = {
      geometries: [surface, wire],
      surfaceShader, wireShader, linesShader,
      meshes: [
        new PIXI.Mesh(surface, surfaceShader, this.state),
        new PIXI.Mesh(wire, wireShader, this.state, PIXI.DRAW_MODES.LINES),
        new PIXI.Mesh(surface, linesShader, this.state)
      ]
    };
    this.stage.addChild(...this.#terrain.meshes);
    this.#addOverlays();
  }

  /**
   * How many wireframe squares fit across and down the image when the grid is set to a size in the map's scale
   * (e.g. 1 square = 20 miles); null for the automatic grid (also without a scale).
   */
  #gridSquares(hx, hz) {
    const {terrain: {grid}, scale: {distance, axis}} = this.data;
    if ( !(grid > 0) || !(distance > 0) ) return null;
    const perUnit = distance / ((axis === "height") ? 2 * hz : 2 * hx);
    const count = length => Math.clamp((length * perUnit) / grid, 1, MAX_GRID_SQUARES);
    return {across: Math.round(count(2 * hx) * 1000) / 1000, down: Math.round(count(2 * hz) * 1000) / 1000};
  }

  /**
   * Lay out a sign: a panel leaning back at `text.tilt` with its foot at SIGN_FOOT, above a projector (SIGN_BASES) in
   * front of it. The panel's length up its plane follows from SIGN_PERSPECTIVE at the default camera; its width from the
   * tile's shape, so that the sign seen from above fills the tile. Everything is placed so that its top edge and the
   * base's front edge are equally far from the middle of the tile.
   */
  #layoutSign() {
    const {tilt: degrees, base: style} = this.data.text;
    const base = SIGN_BASES[style] ?? SIGN_BASES.bar;
    const tilt = Math.toRadians(Math.clamp(Number(degrees) || 60, ...SIGN_TILT_RANGE));
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const foot = SIGN_FOOT;
    const slant = (BASE_DIST - ((BASE_DIST - foot) / SIGN_PERSPECTIVE) - foot) / Math.sin(Math.PI / 3);
    const top = foot + (slant * sin);
    // Size on screen of a point at height y, relative to the floor (from straight above).
    const sigma = y => BASE_DIST / (BASE_DIST - y);
    const sTop = sigma(top);
    const sBase = sigma(base.height);
    const front = base.lens + base.lensOffset + base.depth;
    const depth = slant * cos;
    const zb = ((front * sBase) - (depth * sTop)) / (sTop + sBase);
    const half = (zb + depth) * sTop;
    const hx = (this.width / this.height) * half / sTop;
    return {cos, sin, foot, top, slant, zb, half, hx, base, key: [style, tilt].join()};
  }

  /** Build a sign's base, the floor under it and its beam, and put its panel in place. */
  #buildSign() {
    const sign = this.#sign;
    const hx = this.#hx;
    const corner = (u, v) => this.#surfacePosition(u, v);
    const panel = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    this.panelGeometry.getBuffer("aVertexPosition").update(new Float32Array(panel.flatMap(p => [p.x, p.y, p.z])));
    this.panelGeometry.getBuffer("aTextureCoord").update(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));

    const {height, depth, lens, lensOffset, radius, shadow, style} = sign.base;
    const baseHalf = sign.base.width(hx);
    const lensHalf = Math.max(sign.base.lensWidth(baseHalf), 0.004);
    const lensZ = sign.zb - lens;
    const baseZ = lensZ - lensOffset;
    const topZ = sign.zb + (sign.slant * sign.cos);

    // The beam: faces from the lens to the panel's foot and top edges (16 strips each, so their across coordinate
    // stays straight) and to its sides.
    const positions = [];
    const coords = [];
    const index = [];
    const lensPoint = s => [((s * 2) - 1) * lensHalf, height + 0.002, lensZ];
    const face = (edge, strength) => {
      for ( let k = 0; k < 16; k++ ) {
        const n = positions.length / 3;
        const [s0, s1] = [k / 16, (k + 1) / 16];
        const [a, b] = [edge(s0), edge(s1)];
        positions.push(...lensPoint(s0), ...lensPoint(s1), b.x, b.y, b.z, a.x, a.y, a.z);
        coords.push(s0, 0, strength, s1, 0, strength, s1, 1, strength, s0, 1, strength);
        index.push(n, n + 1, n + 2, n, n + 2, n + 3);
      }
    };
    face(s => corner(s, 1), 1);
    face(s => corner(s, 0), 0.2);
    for ( const side of [0, 1] ) {
      const n = positions.length / 3;
      const [foot, top] = [corner(side, 1), corner(side, 0)];
      positions.push(...lensPoint(side), foot.x, foot.y, foot.z, top.x, top.y, top.z);
      coords.push(0.5, 0, 0.55, 0, 1, 0.55, 1, 1, 0.55);
      index.push(n, n + 1, n + 2);
    }
    const programs = getPrograms();
    const camera = {uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform,
      uVolume: this.volumeUniform, uFrag: this.fragUniform, uColor: this.color};
    const beamShader = new PIXI.Shader(programs.signBeam, {...camera, uOpacity: 1, uFlicker: 1, uPhase: 0});
    const floorShader = new PIXI.Shader(programs.signFloor, {...camera, uOpacity: 1, uFlicker: 1,
      uBase: new Float32Array([0, baseZ, baseHalf, depth]), uRadius: radius, uShadow: shadow,
      uPanel: new Float32Array([hx, sign.zb, topZ, lensZ]), uUnder: 1, uLens: lensHalf});
    const baseShader = new PIXI.Shader(programs.signBase, {...camera, uSize: new Float32Array([baseHalf, depth]),
      uRadius: radius, uStyle: style, uLensAt: new Float32Array([lensOffset, lensHalf]), uLensGlow: 1, uPower: 1,
      uPhase: 0});
    const reach = Math.max(hx, baseHalf) * 1.2;
    const geometries = [
      createFloorRect(-reach, reach, baseZ - depth - 0.25, topZ + 0.1, 0),
      createFloorRect(-baseHalf, baseHalf, baseZ - depth, baseZ + depth, height, [0, baseZ]),
      createPartGeometry(positions, coords, index)
    ];
    const [floorMesh, baseMesh, beamMesh] = [floorShader, baseShader, beamShader]
      .map((shader, i) => new PIXI.Mesh(geometries[i], shader, this.state));
    const rayShader = new PIXI.Shader(programs.signRays, {...camera, uOpacity: 1, uFlicker: 1, uPhase: 0,
      uPages: new Float32Array(3)});
    const rayGeometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", new Float32Array(0), 3)
      .addAttribute("aTextureCoord", new Float32Array(0), 4)
      .addIndex(new Uint16Array(0));
    const rayMesh = new PIXI.Mesh(rayGeometry, rayShader, this.state);
    Object.assign(sign, {geometries, floorMesh, baseMesh, beamMesh, rayMesh, baseZ, baseHalf, lensZ, lensHalf, rayPages: null});
    this.panelMesh.shader = this.signPanelShader;
    // From above: the floor, the base, the panel over them, and the beam's light in front of the panel.
    const at = this.stage.getChildIndex(this.panelMesh);
    this.stage.addChildAt(floorMesh, at);
    this.stage.addChildAt(baseMesh, at + 1);
    this.stage.addChildAt(beamMesh, at + 3);
    this.stage.addChildAt(rayMesh, at + 4);
  }

  /**
   * Aim a sign's rays: SIGN_RAYS per page, from along the lens to random spots in the page's targets (lines of
   * text, images), more to the bigger ones. Rebuilt when the pages are re-rendered.
   */
  #aimRays(pages) {
    const sign = this.#sign;
    sign.rayPages = pages;
    const positions = [];
    const coords = [];
    const index = [];
    const random = seed => {
      const x = Math.sin(seed * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    pages.forEach(({targets}, page) => {
      const areas = targets.map(([u0, v0, u1, v1]) => Math.max(u1 - u0, 0) * Math.max(v1 - v0, 0));
      const total = areas.reduce((sum, a) => sum + a, 0);
      if ( !total ) return;
      for ( let k = 0; k < SIGN_RAYS; k++ ) {
        const seed = (page * 997) + (k * 7.31) + 1;
        let pick = random(seed) * total;
        const box = targets.find((_, i) => (pick -= areas[i]) <= 0) ?? targets.at(-1);
        const u = box[0] + (random(seed + 0.1) * (box[2] - box[0]));
        const v = box[1] + (random(seed + 0.2) * (box[3] - box[1]));
        const to = this.#surfacePosition(u, v);
        const from = {x: ((u * 2) - 1) * sign.lensHalf * 0.85, y: sign.base.height + 0.002, z: sign.lensZ};
        const broad = (k % 2) === 0;
        const near = broad ? 0.006 : 0.0015;
        const far = broad ? 0.05 + (random(seed + 0.3) * 0.07) : 0.003 + (random(seed + 0.3) * 0.008);
        const n = positions.length / 3;
        positions.push(from.x - near, from.y, from.z, from.x + near, from.y, from.z, to.x + far, to.y, to.z, to.x - far, to.y, to.z);
        const own = random(seed + 0.4) + (broad ? 1 : 0);
        coords.push(0, 0, own, page, 1, 0, own, page, 1, 1, own, page, 0, 1, own, page);
        index.push(n, n + 1, n + 2, n, n + 2, n + 3);
      }
    });
    const geometry = sign.rayMesh.geometry;
    geometry.getBuffer("aVertexPosition").update(new Float32Array(positions));
    geometry.getBuffer("aTextureCoord").update(new Float32Array(coords));
    geometry.getIndex().update(new (positions.length / 3 > 65535 ? Uint32Array : Uint16Array)(index));
  }

  #destroySign() {
    const sign = this.#sign;
    this.#sign = null;
    this.panelMesh.shader = this.panelShader;
    if ( !sign?.geometries ) return;
    const rayGeometry = sign.rayMesh.geometry;
    for ( const mesh of [sign.floorMesh, sign.baseMesh, sign.beamMesh, sign.rayMesh] ) mesh.destroy();
    destroyGeometries(...sign.geometries, rayGeometry);
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
    const target = this.data.powered ? 1 : 0;
    this.#power += Math.clamp(target - this.#power, -deltaMS / POWER_MS, deltaMS / POWER_MS);
    this.#powerEase = this.#power * this.#power * (3 - (2 * this.#power));
    // Signs don't shrink away when switched off: they dissolve into their projector (see #updateSign).
    const scale = this.#updateTravel() * (this.#sign ? 1 : 0.04 + (0.96 * this.#powerEase));
    this.cameraUniform.set([this.displayYaw, pitch, dist, this.pixelsPerUnit * scale]);
    this.discCameraUniform.set([this.displayYaw, pitch, BASE_DIST, this.pixelsPerUnit]);
    this.targetUniform.set(this.#recenteredTarget(camera));

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
    const display = showTerrain ? effectiveDisplay(terrain) : "xray";
    this.#applyDisplay(display);

    const parts = [look.ring, look.dashes, look.glow, look.north];
    this.discMesh.visible = parts.some(Boolean);
    this.discShader.uniforms.uParts.set(parts.map(Number));
    const image = this.#image;
    const shaders = showTerrain ? [this.#terrain.surfaceShader, this.#terrain.wireShader, this.#terrain.linesShader] : [this.panelMesh.shader];
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
      const {surfaceShader, wireShader, linesShader} = this.#terrain;
      for ( const {uniforms} of [surfaceShader, wireShader, linesShader] ) {
        uniforms.uHeight = this.#heightmap;
        uniforms.uRelief = terrain.relief * RELIEF_SCALE;
      }
      surfaceShader.uniforms.uContours = linesShader.uniforms.uContours = terrain.contours;
      // A wireframe-only display always shows its wireframe, whatever the overlay setting.
      wireShader.uniforms.uWire = display.startsWith("wire") ? Math.max(terrain.wire, 0.6) : terrain.wire;
    }
    const disc = this.discShader.uniforms;
    disc.uOpacity = look.opacity * this.#powerEase;
    disc.uFlicker = this.#flicker;
    disc.uDashPhase = (seconds * 0.5) % 1;
    this.#updateSign(seconds);
    this.#updateMotes(showTerrain, seconds);
    this.#layoutAreaLabels();
    this.#layoutLines(showTerrain);
    this.#layoutMarkers(pitch);
    this.#drawPings();
    this.#updateTable(seconds);
    this.#drawOff(seconds);
  }

  /**
   * Animate a sign. Switching on, the lens lights and the beam rises first, then the panel materialises from its
   * foot up; switching off runs the other way, leaving the base with its standby light.
   */
  #updateSign(seconds) {
    const sign = this.#sign;
    if ( !sign ) return;
    const {look, text} = this.data;
    const smooth = (from, to, x) => {
      const t = Math.clamp((x - from) / (to - from), 0, 1);
      return t * t * (3 - (2 * t));
    };
    const power = this.#power;
    const beam = smooth(0, 0.45, power);
    const opacity = look.opacity * this.#fade;
    const panel = this.panelMesh.shader.uniforms;
    panel.uOpacity = opacity;
    panel.uReveal = smooth(0.3, 1, power);
    const scenePixels = sign.slant * this.pixelsPerUnit * (FOCAL / BASE_DIST) * (this.tile.document.width / this.width);
    panel.uScanDensity = scenePixels / SIGN_SCANLINE_SPACING;
    // A band of light sweeps up the panel every 6 seconds.
    panel.uSweep = (((seconds % 6) / 1.8) * 1.4) - 0.2;
    panel.uStyle = Math.max(SIGN_PANELS.indexOf(text.panel), 0);
    panel.uScroll = Math.max(SIGN_SCROLLS.indexOf(text.scroll), 0);
    this.#showPages(panel, seconds);
    this.panelMesh.visible = power > 0.3;
    // A panel is lit by a cone of light to its edges; without one, rays go to what is on it.
    const bare = text.panel === "none";
    sign.beamMesh.visible = (beam > 0) && !bare;
    sign.rayMesh.visible = (beam > 0) && bare;
    const pages = this.#textPanel?.pages ?? [];
    if ( bare && (sign.rayPages !== pages) ) this.#aimRays(pages);
    for ( const mesh of [sign.beamMesh, sign.rayMesh] ) {
      const light = mesh.shader.uniforms;
      light.uOpacity = opacity * beam;
      light.uFlicker = this.#flicker;
      light.uPhase = (seconds / 8) % 1;
    }
    const {current, next, change} = this.#pageState;
    sign.rayMesh.shader.uniforms.uPages.set([current, next, change]);
    const floor = sign.floorMesh.shader.uniforms;
    floor.uOpacity = opacity * beam;
    floor.uFlicker = this.#flicker;
    floor.uUnder = bare ? 0 : 1;
    const base = sign.baseMesh.shader.uniforms;
    base.uLensGlow = (0.1 + (0.9 * beam)) * (beam > 0 ? this.#flicker : 1);
    base.uPower = beam;
    base.uPhase = (seconds / 12) % 1;

    // Where the projector is on screen: double-clicking it switches the sign on or off.
    const project = this.#projector();
    const {height, depth} = sign.base;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
      .map(([x, z]) => project({x: x * sign.baseHalf, y: height, z: sign.baseZ + (z * depth)}));
    if ( corners.includes(null) ) sign.spot = null;
    else {
      const xs = corners.map(p => p.x);
      const ys = corners.map(p => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      sign.spot = {x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: Math.max((x1 - x0) / 2, 10), ry: Math.max((y1 - y0) / 2, 10)};
    }
  }

  /**
   * Show the sign's page for this moment: pages take turns every `text.interval` seconds on the shared clock, the
   * next one rising into view over the last SIGN_PAGE_CHANGE_S of each turn. Scrolling starts over with each page.
   */
  #showPages(panel, seconds) {
    const pages = this.#textPanel?.pages ?? [];
    const count = pages.length;
    const {interval: wait, paging} = this.data.text;
    let current = 0;
    let next = 0;
    let change = 0;
    let into = seconds;
    if ( (paging === "manual") && (count > 1) ) {
      // Paged by hand: a new page set on the tile rises in over SIGN_PAGE_CHANGE_S from when it arrives here.
      const target = this.shownPage;
      const now = performance.now();
      if ( this.#flip && (this.#flip.to !== target) ) {
        this.#settledPage = this.#flip.to;
        this.#flip = null;
      }
      if ( (this.#settledPage === null) || (this.#settledPage >= count) ) this.#settledPage = target;
      if ( !this.#flip && (this.#settledPage !== target) ) this.#flip = {from: this.#settledPage, to: target, start: now};
      if ( this.#flip ) {
        change = (now - this.#flip.start) / (SIGN_PAGE_CHANGE_S * 1000);
        if ( change >= 1 ) {
          this.#settledPage = this.#flip.to;
          this.#flip = null;
          change = 0;
        }
      }
      current = this.#flip ? this.#flip.from : this.#settledPage;
      next = this.#flip ? this.#flip.to : current;
    } else if ( count > 1 ) {
      this.#settledPage = null;
      const interval = Math.max(Number(wait) || 8, 2);
      current = Math.floor(seconds / interval) % count;
      next = (current + 1) % count;
      into = seconds % interval;
      change = Math.clamp((into - (interval - SIGN_PAGE_CHANGE_S)) / SIGN_PAGE_CHANGE_S, 0, 1);
    }
    this.#pageState = {current, next, change};
    const window = (uniform, page, time) => {
      if ( !page ) return uniform.set([1, 1, 0, 0]);
      const [u, v] = page.window;
      const [ru, rv] = page.rate;
      uniform.set([u, v, (ru * time) % 1, (rv * time) % 1]);
    };
    panel.uImage = pages[current]?.texture ?? PIXI.Texture.EMPTY;
    window(panel.uWindow, pages[current], into);
    panel.uImage2 = (change > 0) ? pages[next].texture : PIXI.Texture.EMPTY;
    window(panel.uWindow2, (change > 0) ? pages[next] : null, 0);
    panel.uChange = change;
    // The lit dot slides from page to page the short way round.
    const step = (((next - current) % count) + count + (count / 2)) % count - (count / 2);
    panel.uPages.set([count, (((current + (step * change)) % count) + count) % count]);
    panel.uManual = ((paging === "manual") && (count > 1)) ? 1 : 0;
  }

  /** Re-read a sign's content (its journal changed, or the in-game time it shows); it re-renders only on a change. */
  refreshText() {
    if ( this.#textPanel ) this.#updateTextPanel();
  }

  /** Whether the sign shows the in-game date or time. */
  get showsTime() {
    return !!this.#textPanel?.usesTime;
  }

  /** How many pages the sign shows (0 before they are rendered, or not a sign). */
  get pageCount() {
    return this.#textPanel?.pages.length ?? 0;
  }

  /** The page a sign shows (or is turning to): by the clock, or the tile's `page` when paged by hand. */
  get shownPage() {
    const count = this.pageCount;
    if ( count < 2 ) return 0;
    if ( this.data.text.paging === "manual" ) return (((Math.trunc(this.data.page) || 0) % count) + count) % count;
    const interval = Math.max(Number(this.data.text.interval) || 8, 2);
    return Math.floor((game.time.serverTime / 1000) / interval) % count;
  }

  /**
   * Is a render-texture point on a sign's projector?
   * @param {{x: number, y: number}} point
   */
  projectorAt({x, y}) {
    const spot = this.#sign?.spot;
    if ( !spot ) return false;
    return (Math.abs(x - spot.x) <= spot.rx) && (Math.abs(y - spot.y) <= spot.ry);
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
    uniforms.uHeight.set([look.lift, (showTerrain ? terrain.relief * RELIEF_SCALE : 0) + 0.4]);
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
      const [surface, wire, lines] = this.#terrain.meshes;
      const wireOnly = display.startsWith("wire");
      surface.visible &&= display !== "wireXray";
      lines.visible &&= wireOnly;
      surface.state = depth ? this.depthWriteState : this.state;
      wire.state = depth ? this.depthReadState : this.state;
      this.#terrain.surfaceShader.uniforms.uOpaque = (display === "solid") ? 1 : 0;
      this.#terrain.surfaceShader.uniforms.uDepthOnly = (display === "wire") ? 1 : 0;
      lines.state = depth ? this.depthReadState : this.state;
    }
    const tested = depth ? this.depthReadState : this.state;
    this.moteMesh.state = tested;
    for ( const layer of [this.strokeLayer, this.liveStrokeLayer] ) layer.setState(tested);
    // Measurements stay readable on top of the relief
    for ( const layer of [this.measureLines, this.liveMeasureLines] ) layer.setState(this.state);
  }

  /** Content opacity: the look's, faded in after travelling to another map. The projector disc doesn't fade. */
  get #opacity() {
    return this.data.look.opacity * this.#fade * this.#powerEase;
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
    this.#liveArea = null;
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

  /**
   * Where the view looks: the camera's point, or, just after going up on a tile that recentres, a point easing from
   * the spot the old map was at to the saved (centred) one. Grabbing the hologram ends the pan.
   * @param {object} camera
   * @returns {number[]}
   */
  #recenteredTarget({x, z}) {
    const pan = this.#recenter;
    if ( !pan ) return [x, z];
    const t = (performance.now() - pan.start) / RECENTER_MS;
    if ( (t >= 1) || this.#dragging ) {
      this.#recenter = null;
      return [x, z];
    }
    const left = 1 - (t * t * (3 - (2 * t)));
    const spotX = Math.clamp(((pan.u * 2) - 1) * this.#hx, -1, 1);
    const spotZ = Math.clamp((1 - (pan.v * 2)) * this.#hz, -1, 1);
    return [x + ((spotX - x) * left), z + ((spotZ - z) * left)];
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
    if ( this.#textPanel && (this.resolution !== resolution) ) {
      const drawn = this.#textResolution;
      const stale = (drawn === null) || (resolution > drawn) || ((resolution * TEXT_OVERSHARP) < drawn);
      this.#textDue = stale ? performance.now() + TEXT_SETTLE_MS : 0;
    }
    this.resolution = resolution;
    if ( this.#textPanel && this.#textDue && (performance.now() >= this.#textDue) ) this.#updateTextPanel();
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
    if ( this.tableMesh.visible && (this.#tableHoleDrawn !== this.#tableHole()) ) this.#drawTableTexture(renderer, this.#tableHole());
    this.areaLayer.drawOverlay(renderer, this.#areaOverlays(), this.#hx / this.#hz);
    renderer.state.set(this.state);
    // Fully off, only the off state is drawn.
    const keep = [this.offGraphics, this.tableMesh, this.#sign?.floorMesh, this.#sign?.baseMesh];
    const hidden = (this.#power > 0) ? [] : this.stage.children.filter(c => !keep.includes(c) && c.visible);
    for ( const child of hidden ) child.visible = false;
    renderer.render(this.stage, {renderTexture: this.renderTexture, clear: true, transform});
    for ( const child of hidden ) child.visible = true;
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
    const portals = map.children.map(({uuid, id, name, u, v, size, color, locked}) => ({id, u, v, label: name,
      glyph: "portal", color: color ?? look.color, size, locked, portal: uuid}));
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
      case "ping":
        this.#pings.push({u: preview.u, v: preview.v, color: new PIXI.Color(preview.color).toNumber(),
          start: performance.now()});
        this.#pings.splice(0, this.#pings.length - MAX_PINGS);
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
    const shape = [this.#hx, this.#hz, this.#sign?.zb, look.lift, onTerrain ? terrain.relief : 0, step].join();
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
    this.#measureLabelItems = this.#prepareMeasureLabels(measures);
  }

  /** What the measurement layer lays out this frame (see #layoutMarkers). */
  #measureLabelItems = [];

  /** Endpoint dots and distance labels, with the camera as drawn this frame: where they may go. */
  #prepareMeasureLabels(measures) {
    const size = Math.clamp(Math.min(this.width, this.height) * 0.016, 6, 24);
    const all = [...measures, ...this.#liveMeasures];
    const labels = all.map(({id, points}) => ({id, text: this.#distanceLabel(points)}));
    this.measureLabels.sync(labels, size, this.#labelSize, this.selectedMeasure, this.resolution);
    const project = this.#projector();
    return all.map(({id, points: [ua, va, ub, vb]}) => {
      const from = this.#surfacePosition(ua, va);
      const to = this.#surfacePosition(ub, vb);
      const at = t => {
        const point = project({x: from.x + ((to.x - from.x) * t), y: from.y + ((to.y - from.y) * t), z: from.z + ((to.z - from.z) * t)});
        if ( !point ) return null;
        const alpha = this.#opacity * this.#flicker * this.#volumeAlpha(point) * depthFade(point.depth);
        return {point, alpha, scale: this.#perspective(point.depth)};
      };
      return {id, a: project(from), b: project(to), at};
    });
  }

  #distanceLabel(points) {
    const metres = this.measureLength(points);
    if ( metres === null ) return game.i18n.localize("VIRAHOLO.Measure.NoScale");
    return formatDistance(metres, this.data.scale.unit);
  }

  /** Saved and pending areas, minus erased ones, as shown here. */
  get areas() {
    return this.#shown("areas");
  }

  /** Show (or with null stop showing) the area this client is drawing: {shape, points, color}. */
  setLiveArea(area) {
    this.#liveArea = area;
  }

  /**
   * An area's outline as [u, v, ...]: a polygon's corners, or a circle traced round its centre. Circles are round
   * across the map (in object space), whatever the image's shape.
   */
  areaOutline({shape, points}) {
    if ( shape !== "circle" ) return points;
    const [cu, cv, eu, ev] = points;
    const rx = (eu - cu) * 2 * this.#hx;
    const rz = (ev - cv) * 2 * this.#hz;
    const radius = Math.hypot(rx, rz);
    const steps = 64;
    const outline = [];
    for ( let k = 0; k < steps; k++ ) {
      const angle = (k / steps) * TAU;
      outline.push(cu + ((Math.cos(angle) * radius) / (2 * this.#hx)), cv + ((Math.sin(angle) * radius) / (2 * this.#hz)));
    }
    return outline;
  }

  /** What the overlay draws: every area shown, then the one being drawn (open while it's a polygon in progress). */
  #areaOverlays() {
    const shown = this.areas.map(area => ({id: area.id, color: area.color, outline: this.areaOutline(area), closed: true,
      selected: area.id === this.selectedArea}));
    const live = this.#liveArea;
    if ( live?.points.length >= 4 ) {
      const closed = live.shape === "circle";
      shown.push({id: "live", color: live.color, outline: closed ? this.areaOutline(live) : live.points, closed, selected: false});
    }
    return shown;
  }

  /** Each area's label at its middle: its name, else its size (with a scale), else a plain mark. */
  #layoutAreaLabels() {
    const areas = this.areas;
    const size = Math.clamp(Math.min(this.width, this.height) * 0.015, 6, 22);
    const labels = areas.map(area => {
      const squareMetres = this.areaSize(area);
      const text = area.label || ((squareMetres === null) ? "◇" : formatArea(squareMetres, this.data.scale.unit));
      return {id: area.id, text, color: area.color};
    });
    const sprites = this.areaLayer.sync(labels, size, this.#labelSize, this.selectedArea, this.resolution);
    const project = this.#projector();
    for ( const area of areas ) {
      const sprite = sprites.get(area.id);
      const [u, v] = this.#areaMiddle(area);
      const point = project(this.#surfacePosition(u, v));
      if ( !point ) {
        sprite.container.visible = false;
        continue;
      }
      sprite.place(point, this.#opacity * this.#flicker * this.#volumeAlpha(point) * depthFade(point.depth),
        this.#perspective(point.depth));
    }
  }

  /** Where an area's label goes: a circle's centre, or the middle of a polygon's corners. */
  #areaMiddle({shape, points}) {
    if ( shape === "circle" ) return [points[0], points[1]];
    let u = 0;
    let v = 0;
    for ( let i = 0; i < points.length; i += 2 ) {
      u += points[i];
      v += points[i + 1];
    }
    return [u / (points.length / 2), v / (points.length / 2)];
  }

  /**
   * An area's size in square metres, from the hologram's scale (across the map, like distances); null without one.
   * @param {object} area
   * @returns {number|null}
   */
  areaSize(area) {
    const {distance, unit, axis} = this.data.scale;
    if ( !(distance > 0) || !UNITS[unit] ) return null;
    const metresPerUnit = (distance * UNITS[unit].metres) / ((axis === "height") ? 2 * this.#hz : 2 * this.#hx);
    const outline = this.areaOutline(area);
    let twice = 0;
    for ( let i = 0; i < outline.length; i += 2 ) {
      const j = (i + 2) % outline.length;
      const [x0, z0] = [outline[i] * 2 * this.#hx, outline[i + 1] * 2 * this.#hz];
      const [x1, z1] = [outline[j] * 2 * this.#hx, outline[j + 1] * 2 * this.#hz];
      twice += (x0 * z1) - (x1 * z0);
    }
    return Math.abs(twice / 2) * (metresPerUnit ** 2);
  }

  /** Where an image point on the surface is drawn, in render-texture pixels (null behind the camera). */
  surfacePoint(u, v) {
    return this.#project(this.#surfacePosition(u, v));
  }

  /** The area whose label is under a render-texture point, if any. */
  areaAt(point) {
    return this.areaLayer.hitTest(point.x, point.y);
  }

  /** Where an area's label is drawn (its top centre), in render-texture pixels. */
  areaTip(id) {
    const bounds = this.areaLayer.get(id)?.bounds;
    return bounds ? {x: bounds.x + (bounds.width / 2), y: bounds.y} : null;
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
    const sign = this.#sign;
    if ( sign ) {
      const along = (1 - v) * sign.slant;
      return {x: ((u * 2) - 1) * this.#hx, y: sign.foot + (along * sign.sin), z: sign.zb + (along * sign.cos)};
    }
    const {lift} = this.data.look;
    const relief = this.data.terrain.relief * RELIEF_SCALE;
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
  #projector(camera=this.cameraUniform, target=this.targetUniform) {
    const [yaw, pitch, dist, ppu] = camera;
    const [tx, tz] = target;
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

  /**
   * Draw the pings: rings spreading across the surface from the spot, and a pointer dropping onto it. Everything
   * follows the surface (and the camera) as it turns, so the cue stays on the place pointed at.
   */
  #drawPings() {
    const g = this.pingGraphics;
    g.clear();
    const now = performance.now();
    this.#pings = this.#pings.filter(ping => now - ping.start < PING_MS);
    if ( !this.#pings.length ) return;
    const project = this.#projector();
    const base = this.#opacity * this.#flicker;
    const reach = Math.min(this.#hx, this.#hz) * 0.4;
    const width = Math.max(2, Math.min(this.width, this.height) / 300);
    for ( const {u, v, color, start} of this.#pings ) {
      const t = (now - start) / PING_MS;
      const centre = this.#surfacePosition(u, v);
      const middle = project(centre);
      if ( !middle ) continue;
      const fade = base * this.#volumeAlpha(middle) * depthFade(middle.depth) * Math.min(1, (1 - t) * 3);
      for ( let i = 0; i < 3; i++ ) {
        const p = Math.clamp((t - (i * 0.14)) / 0.6, 0, 1);
        if ( (p <= 0) || (p >= 1) ) continue;
        const radius = reach * (1 - ((1 - p) ** 3));
        g.lineStyle({width: width * (1.6 - p), color, alpha: fade * Math.min(1, (1 - p) * 1.6)});
        let first = true;
        for ( let k = 0; k <= 40; k++ ) {
          const angle = (k / 40) * TAU;
          // Offsets on the image (terrain heights are clamped to its edge), so rings lie on a sign's tilted panel too.
          const du = (Math.cos(angle) * radius) / (2 * this.#hx);
          const dv = -(Math.sin(angle) * radius) / (2 * this.#hz);
          const point = project(this.#surfacePosition(u + du, v + dv));
          if ( !point ) continue;
          if ( first ) g.moveTo(point.x, point.y);
          else g.lineTo(point.x, point.y);
          first = false;
        }
      }
      // The pointer falls onto the spot, settles with a small bounce, and fades with the rings.
      const drop = Math.clamp(t / 0.3, 0, 1);
      const height = STEM_HEIGHT * (0.3 + (2.2 * ((1 - drop) ** 2)) + (0.15 * Math.sin(drop * Math.PI)));
      const tip = middle;
      const top = project({...centre, y: centre.y + height});
      if ( !top ) continue;
      const size = Math.clamp(Math.min(this.width, this.height) * 0.02, 6, 22);
      g.lineStyle({width: width, color, alpha: fade * 0.7});
      g.moveTo(tip.x, tip.y).lineTo(top.x, top.y);
      g.lineStyle(0).beginFill(color, fade * 0.25 * (1 - t));
      g.drawCircle(tip.x, tip.y, size * (0.8 + t));
      g.endFill();
      g.beginFill(color, fade);
      g.moveTo(top.x - size, top.y - (size * 1.5)).lineTo(top.x + size, top.y - (size * 1.5)).lineTo(top.x, top.y).closePath();
      g.drawCircle(tip.x, tip.y, width * 1.6);
      g.endFill();
    }
  }

  /** Does the off table have a hole (the tile spans enough grid squares)? */
  #tableHole() {
    const {width, height} = this.tile.document;
    return Math.min(width, height) / canvas.grid.size >= TABLE_HOLE_SQUARES;
  }

  /** Show the off table (when that's the off style and not fully on) with the content's hologram look. */
  #updateTable(seconds) {
    const {look, offStyle} = this.data;
    const shown = (offStyle === "table") && (this.#power < 1) && !this.#sign;
    this.tableMesh.visible = shown;
    if ( !shown ) return;
    this.offCameraUniform[3] = this.pixelsPerUnit;
    const {uniforms} = this.tableShader;
    uniforms.uImage = this.#tableTexture ?? PIXI.Texture.EMPTY;
    uniforms.uOpacity = look.opacity * (1 - this.#power);
    uniforms.uSolidity = look.solidity;
    uniforms.uScan = look.scanlines;
    uniforms.uScanDensity = this.scanDensity;
    uniforms.uScanPhase = (seconds * 0.8) % 1;
    uniforms.uFlicker = this.#flicker;
  }

  /**
   * Draw the table top, top-down, in white on transparent (the shader tints it): a translucent top, a bright rim,
   * inlaid rings and ticks, and the emitter, in a hole or as a pad.
   */
  #drawTableTexture(renderer, hole) {
    const size = TABLE_TEXTURE_SIZE;
    const c = size / 2;
    const r = c * 0.97;
    const g = new PIXI.Graphics();
    const polar = (radius, angle) => [c + (Math.cos(angle) * radius), c + (Math.sin(angle) * radius)];
    g.beginFill(0xffffff, 0.2).drawCircle(c, c, r);
    if ( hole ) g.beginHole().drawCircle(c, c, r * TABLE_HOLE).endHole();
    g.endFill();
    g.lineStyle(7, 0xffffff, 1).drawCircle(c, c, r);
    g.lineStyle(3, 0xffffff, 0.4).drawCircle(c, c, r * 0.975);
    for ( const f of [0.84, 0.66] ) g.lineStyle(3, 0xffffff, 0.5).drawCircle(c, c, r * f);
    g.lineStyle(2, 0xffffff, 0.25);
    for ( let k = 0; k < 8; k++ ) {
      const angle = (k / 8) * TAU;
      g.moveTo(...polar(r * 0.66, angle)).lineTo(...polar(r * 0.84, angle));
    }
    g.lineStyle(4, 0xffffff, 0.85);
    for ( let k = 0; k < 24; k++ ) {
      const angle = (k / 24) * TAU;
      g.moveTo(...polar(r * 0.9, angle)).lineTo(...polar(r * 0.95, angle));
    }
    const emitter = r * (hole ? TABLE_HOLE : TABLE_PAD);
    g.lineStyle(0);
    for ( const [scale, alpha] of [[1.5, 0.07], [1.25, 0.12]] ) g.beginFill(0xffffff, alpha).drawCircle(c, c, emitter * scale).endFill();
    g.beginFill(0xffffff, hole ? 0.3 : 0.5).drawCircle(c, c, emitter).endFill();
    g.lineStyle(8, 0xffffff, 1).drawCircle(c, c, emitter);
    this.#tableTexture ??= PIXI.RenderTexture.create({width: size, height: size});
    renderer.render(g, {renderTexture: this.#tableTexture, clear: true});
    g.destroy();
    this.#tableHoleDrawn = hole;
  }

  /**
   * The switched-off look, fading with the power: a small glowing square, or a round table across the projection
   * area (with a hole in the middle if the tile spans enough grid squares) whose centre glows. Clicking the glowing
   * spot switches on (see powerSpotAt).
   */
  #drawOff(seconds) {
    const g = this.offGraphics;
    g.clear();
    this.#powerSpot = null;
    const alpha = 1 - this.#power;
    if ( alpha <= 0.001 ) return;
    // A sign's off state is its projector base, which stays on show: that is what switches it on.
    if ( this.#sign ) {
      this.#powerSpot = this.#sign.spot;
      return;
    }
    const project = this.#projector(this.offCameraUniform, [0, 0]); // Always from straight above, north up
    const color = new PIXI.Color(this.data.look.color).toNumber();
    const pulse = 0.65 + (0.35 * Math.sin(seconds * 2.6));
    const width = Math.max(1.5, Math.min(this.width, this.height) / 300);
    const ring = (radius, y, steps=72, offset=0) => {
      const points = [];
      for ( let k = 0; k < steps; k++ ) {
        const angle = offset + ((k / steps) * TAU);
        const p = project({x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius});
        if ( p ) points.push(p);
      }
      return points;
    };
    const flat = points => points.flatMap(p => [p.x, p.y]);
    const spot = (points, y) => {
      const centre = project({x: 0, y, z: 0});
      if ( !centre ) return;
      const rx = Math.max(...points.map(p => Math.abs(p.x - centre.x)));
      const ry = Math.max(...points.map(p => Math.abs(p.y - centre.y)));
      this.#powerSpot = {x: centre.x, y: centre.y, rx: Math.max(rx, 14), ry: Math.max(ry, 14)};
    };

    if ( this.data.offStyle === "table" ) {
      // The table itself is a hologram (tableMesh); only its glowing switch-on spot pulses here.
      const emitter = TABLE_RADIUS * (this.#tableHole() ? TABLE_HOLE : TABLE_PAD);
      const edge = ring(emitter, 0);
      g.lineStyle({width: width * 1.4, color, alpha: alpha * (0.3 + (0.5 * pulse))}).drawPolygon(flat(edge));
      spot(edge, 0);
      return;
    }

    // A small floating square: a frame, a turning inner square and a soft glow
    const half = 0.12;
    const square = (size, angle, y) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
      const x = sx * size;
      const z = sz * size;
      return project({x: (x * Math.cos(angle)) - (z * Math.sin(angle)), y, z: (x * Math.sin(angle)) + (z * Math.cos(angle))});
    }).filter(Boolean);
    const frame = square(half, 0, 0.03);
    g.lineStyle(0).beginFill(color, alpha * 0.1 * pulse).drawPolygon(flat(square(half * 1.7, 0, 0.03))).endFill();
    g.beginFill(color, alpha * 0.16 * pulse).drawPolygon(flat(frame)).endFill();
    g.lineStyle({width: width * 1.4, color, alpha: alpha * (0.55 + (0.4 * pulse))}).drawPolygon(flat(frame));
    g.lineStyle({width, color, alpha: alpha * 0.8}).beginFill(color, alpha * 0.35).drawPolygon(flat(square(half * 0.5, seconds * 0.7, 0.03))).endFill();
    spot(frame, 0.03);
  }

  /**
   * Is a render-texture point on the glowing spot that switches the hologram on?
   * @param {{x: number, y: number}} point
   */
  powerSpotAt({x, y}) {
    const spot = this.#powerSpot;
    if ( !spot || (this.#power > 0) ) return false;
    return (((x - spot.x) / spot.rx) ** 2) + (((y - spot.y) / spot.ry) ** 2) <= 1;
  }

  /** The label size setting, within its range. */
  get #labelSize() {
    const [min, max] = MARKING_RANGES.labelSize;
    return Math.clamp(Number(this.data.look.labelSize) || 1, min, max);
  }

  /**
   * How much bigger than usual a pin or label at this depth is drawn: as perspective would have it (1 at the depth
   * the camera looks at), within limits so far ones stay readable and near ones don't crowd the rest.
   * @param {number} depth
   */
  #perspective(depth) {
    const dist = this.cameraUniform[2];
    return Math.clamp(dist / Math.max(dist + depth, 0.05), MIN_SCALE, MAX_SCALE);
  }

  /**
   * Stand the waypoints on the surface, and lay out the labels: area labels stay put, measurement labels keep clear
   * of them and of the pins' heads, and pin labels of all of those.
   */
  #layoutMarkers(pitch) {
    const {look} = this.data;
    const markers = this.markers;
    const size = Math.clamp(Math.min(this.width, this.height) * 0.022, 7, 32);
    this.markerLayer.sync(markers, {size, labelSize: this.#labelSize, labels: look.labels, selected: this.selectedMarker,
      resolution: this.resolution});
    const [min, max] = MARKING_RANGES.pinHeight;
    const stem = STEM_HEIGHT * Math.clamp(Number(look.pinHeight) || 0, min, max);
    const project = this.#projector();
    const pins = [];
    for ( const marker of markers ) {
      const surface = this.#surfacePosition(marker.u, marker.v);
      const base = project(surface);
      const height = stem * (STEM_TIERS[marker.size] ?? 1);
      const head = project({...surface, y: surface.y + height});
      const above = project({...surface, y: surface.y + height + 0.1});
      if ( !base || !head || !above ) {
        this.markerLayer.get(marker.id).container.visible = false;
        continue;
      }
      // Which way a stem grows on screen (straight up, unless the camera looks down along it).
      const length = Math.hypot(above.x - head.x, above.y - head.y);
      const up = (length > 1) ? {x: (above.x - head.x) / length, y: (above.y - head.y) / length} : {x: 0, y: -1};
      const alpha = this.#opacity * this.#flicker * this.#volumeAlpha(base) * depthFade(base.depth);
      pins.push({id: marker.id, tier: marker.size, base, head, up, depth: head.depth, scale: this.#perspective(head.depth), alpha});
    }
    const areas = this.areaLayer.boxes;
    const heads = pins.filter(pin => pin.alpha > 0.05).map(pin => this.markerLayer.get(pin.id).headRect(pin.head, pin.scale));
    const mode = this.#layoutMode(markers, pins, areas);
    this.measureLabels.layout(this.#measureLabelItems, [...areas, ...heads], this.selectedMeasure, mode);
    this.markerLayer.layout(pins, [...this.measureLabels.boxes, ...areas], {
      width: this.width, height: this.height, squash: Math.sin(pitch), lean: look.pinLean !== false,
      focus: [this.hoveredMarker, this.selectedMarker].filter(Boolean), mode
    });
  }

  /**
   * What labels were last laid out around, since when it has held still, whether they've been laid out afresh since,
   * and when it last started moving from rest.
   */
  #rest = {key: "", since: 0, fresh: false, moved: -Infinity};

  /**
   * How to lay out the labels this frame, from whether everything they're laid out around (pin heads, measurement
   * ends, area labels, the labels themselves) is moving. Once it has held still for STILL_MS they're laid out afresh,
   * all in one move ("fresh"). For STILL_MS after it starts moving from rest they hold their places ("hold"), so a
   * jump of the view also ends in one move. Otherwise, while it keeps moving, each label stays where it is as long as
   * it can ("follow"), so labels don't hop about as the view turns.
   * @returns {"fresh"|"hold"|"follow"}
   */
  #layoutMode(markers, pins, areas) {
    const round = value => Math.round(value * 2);
    const point = p => (p ? `${round(p.x)},${round(p.y)}` : "-");
    const key = [
      this.#labelSize, this.data.look.labels, this.data.look.pinLean, this.selectedMarker, this.selectedMeasure,
      ...markers.map(m => `${m.id}:${m.size}:${m.label}`),
      ...pins.map(pin => `${pin.id}:${point(pin.head)}:${round(pin.scale * 10)}`),
      ...this.#measureLabelItems.map(item => `${item.id}:${point(item.a)}:${point(item.b)}`),
      ...areas.map(box => `${point(box)}:${round(box.w)}`)
    ].join("|");
    const now = performance.now();
    const rest = this.#rest;
    if ( key !== rest.key ) this.#rest = {key, since: now, fresh: false, moved: rest.fresh ? now : rest.moved};
    else if ( !rest.fresh && (now - rest.since >= STILL_MS) ) {
      rest.fresh = true;
      return "fresh";
    }
    return (now - this.#rest.moved < STILL_MS) ? "hold" : "follow";
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
    const {x, z} = this.#surfacePosition(u, v);
    return {x: Math.clamp(x, -1, 1), z: Math.clamp(z, -1, 1)};
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
    const sign = this.#sign;
    if ( sign ) {
      // Against the sign's tilted panel: (y − foot)·cos − (z − zb)·sin = 0 on it.
      const p0 = at(0);
      const p1 = at(1);
      const off = p => ((p.y - sign.foot) * sign.cos) - ((p.z - sign.zb) * sign.sin);
      const rate = off(p1) - off(p0);
      if ( Math.abs(rate) < 1e-9 ) return null;
      const t = -off(p0) / rate;
      if ( t <= 0 ) return null;
      const p = at(t);
      const along = ((p.y - sign.foot) * sign.sin) + ((p.z - sign.zb) * sign.cos);
      const uv = {u: ((p.x / this.#hx) + 1) / 2, v: 1 - (along / sign.slant)};
      return inside(uv) ? uv : null;
    }
    const {lift} = this.data.look;
    if ( Math.abs(slope) < 1e-6 ) return null;

    if ( !this.#terrain || !this.#heights ) {
      const t = tAtHeight(lift);
      if ( t <= 0 ) return null;
      const uv = toUV(at(t));
      return inside(uv) ? uv : null;
    }

    const relief = this.data.terrain.relief * RELIEF_SCALE;
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
    this.#destroySign();
    this.#destroyTerrain();
    this.markerLayer.destroy();
    this.strokeLayer.destroy();
    this.liveStrokeLayer.destroy();
    this.measureLines.destroy();
    this.liveMeasureLines.destroy();
    this.measureLabels.destroy();
    this.areaLayer.destroy();
    this.moteMesh.destroy();
    this.stage.destroy({children: true});
    destroyGeometries(this.discGeometry, this.panelGeometry, this.moteGeometry, this.tableGeometry);
    this.#tableTexture?.destroy(true);
    this.texture.destroy(false);
    this.renderTexture.destroy(true);
  }
}
