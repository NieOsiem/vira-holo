import {getHoloData} from "./data.mjs";
import MarkerLayer from "./marker-layer.mjs";
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
const MAX_RT_SIZE = 2048;
const DISC_RADIUS = 1.08;
/** One scanline per this many scene pixels of tile height. */
const SCANLINE_SPACING = 6;
/** Waypoint stem height, in footprint units. */
const STEM_HEIGHT = 0.16;
/** Longest side of the CPU copy of a heightmap, used to stand waypoints on the terrain and to pick points on it. */
const HEIGHT_SAMPLES = 512;
/** Approximate number of wireframe lines across the terrain in each direction. */
const WIRE_LINES = 40;
const CONTOUR_LEVELS = 12;

/**
 * Projects an object-space point (x right, y up, z away from the default viewer) through the orbit camera.
 * The perspective divide is left to the GPU (w = view depth) so varyings interpolate perspective-correctly.
 */
const PROJECT = `
vec4 project(vec3 p) {
  p.xz -= uTarget;
  float cy = cos(uCamera.x), sy = sin(uCamera.x), cp = cos(uCamera.y), sp = sin(uCamera.y);
  float x = p.x * cy + p.z * sy;
  float z1 = p.z * cy - p.x * sy;
  float y = p.y * cp + z1 * sp;
  float z = z1 * cp - p.y * sp;
  vDepth = z;
  float w = z + uCamera.z;
  vec2 offset = vec2(x, -y) * ${FOCAL.toFixed(2)} * uCamera.w;
  vec3 clip = projectionMatrix * translationMatrix * vec3(uCenter * w + offset, w);
  return vec4(clip.xy, 0.0, w);
}`;

const CAMERA_UNIFORMS = `
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec4 uCamera; // yaw, pitch, distance, render-texture pixels per unit
uniform vec2 uTarget; // floor point the camera looks at
uniform vec2 uCenter;`;

/** Fades content out towards the edge of the projection area, so panned or zoomed content never ends in a hard cut. */
const VOLUME = `
uniform vec3 uVolume; // render-texture width and height; z = 1 for a rectangular (sign) area, 0 for elliptical
float volumeFade() {
  vec2 q = abs((gl_FragCoord.xy / uVolume.xy) * 2.0 - 1.0);
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

// Returns premultiplied emitted colour (rgb) and its alpha (a) before solidity.
vec4 holoColor(vec4 tex, float shade) {
  vec3 rgb = tex.a > 0.0 ? tex.rgb / tex.a : vec3(0.0);
  float lum = smoothstep(0.2, 0.8, dot(rgb, vec3(0.299, 0.587, 0.114)));
  vec3 color = mix(rgb, uColor * (0.1 + 1.4 * lum), uTint) * shade;
  // A hologram is emitted light: when tinted, dark parts of the image glow (and block) less.
  float emission = mix(1.0, 0.2 + 0.8 * lum, uTint);
  float scan = 1.0 - uScan * 0.6 * (0.5 + 0.5 * sin((gl_FragCoord.y * uScanDensity + uScanPhase) * 6.2831853));
  float a = tex.a * emission * uOpacity * scan * uFlicker;
  return vec4(color * a, a);
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
  gl_Position = project(p);
}`;

const TERRAIN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
in float vDepth;
in float vHeight;
in float vShade;
${HOLO_LOOK}
uniform float uContours;
out vec4 fragColor;

void main() {
  float depth = depthFade(vDepth, 0.6);
  vec4 holo = holoColor(texture(uImage, vUV), vShade) * depth;
  float level = vHeight * ${CONTOUR_LEVELS.toFixed(1)};
  float distToLevel = abs(fract(level + 0.5) - 0.5);
  float contour = (1.0 - smoothstep(0.0, 1.2 * fwidth(level), distToLevel)) * smoothstep(0.02, 0.05, vHeight);
  vec3 lines = uColor * contour * uContours * 0.9 * uFlicker * depth;
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

let programs;
function getPrograms() {
  programs ??= {
    panel: PIXI.Program.from(VERTEX, PANEL_FRAGMENT, "vira-holo-panel"),
    disc: PIXI.Program.from(VERTEX, DISC_FRAGMENT, "vira-holo-disc"),
    terrain: PIXI.Program.from(TERRAIN_VERTEX, TERRAIN_FRAGMENT, "vira-holo-terrain"),
    wire: PIXI.Program.from(TERRAIN_VERTEX, WIRE_FRAGMENT, "vira-holo-wire")
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
    this.cameraUniform = new Float32Array(4);
    this.discCameraUniform = new Float32Array(4);
    this.targetUniform = new Float32Array(2);
    this.centerUniform = new Float32Array(2);
    this.volumeUniform = new Float32Array(3);
    this.color = new Float32Array(3);
    this.state = new PIXI.State();

    const {panel, disc} = getPrograms();
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
    this.stage = new PIXI.Container();
    this.markerLayer = new MarkerLayer();
    this.stage.addChild(this.discMesh, this.panelMesh, this.markerLayer.container);
    this.configure();
  }

  /** Unsaved camera shown while someone drags the hologram (locally or on another client). */
  #liveCamera = null;
  #liveUntil = 0;
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
  /** CPU copy of the heightmap: {width, height, data: Float32Array}. */
  #heights = null;
  #hx = 1;
  #hz = 1;
  /** @type {Map<string, {u: number, v: number}>} Unsaved positions of waypoints being dragged. */
  #liveMarkers = new Map();
  /** Waypoint whose card is open on this client. */
  selectedMarker = null;

  #lookUniforms(extra={}) {
    return {
      uCamera: this.cameraUniform, uTarget: this.targetUniform, uCenter: this.centerUniform, uColor: this.color,
      uVolume: this.volumeUniform, uImage: PIXI.Texture.EMPTY,
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
      this.#liveCamera = null;
      this.#liveMarkers.clear();
    }
    this.color.set(new PIXI.Color(data.look.color).toRgbArray());
    this.resize();
    const src = (data.mode === "terrain") ? data.terrain.heightmap : null;
    if ( src !== this.#heightmapSrc ) this.#loadHeightmap(src);
    if ( data.mode === "text" ) {
      this.#textPanel ??= new TextPanel();
      const {width, height} = this.tile.document;
      this.#textPanel.update(data.text, width * FILL, height * FILL);
    }
    else {
      this.#textPanel?.destroy();
      this.#textPanel = null;
    }
    this.#updateGeometry();
  }

  /** The texture shown on the panel or draped over the terrain. */
  get #image() {
    if ( this.#textPanel ) return this.#textPanel.texture;
    return this.tile.texture ?? PIXI.Texture.EMPTY;
  }

  /**
   * Match the render texture to the Tile's size.
   * @returns {boolean} Whether the size changed
   */
  resize() {
    const {width, height} = this.tile.document;
    const scale = Math.min(1, MAX_RT_SIZE / Math.max(width, height, 1));
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    const rt = this.renderTexture;
    const changed = (rt.width !== w) || (rt.height !== h);
    if ( changed ) rt.resize(w, h);
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
    const rt = this.renderTexture;
    const fitRect = mode === "text";
    let hx;
    let hz;
    if ( fitRect ) {
      const longest = Math.max(rt.width, rt.height);
      hx = rt.width / longest;
      hz = rt.height / longest;
    } else {
      const image = this.#image;
      const aspect = (image.width && image.height) ? (image.width / image.height) : 1;
      const diagonal = Math.hypot(aspect, 1);
      hx = aspect / diagonal;
      hz = 1 / diagonal;
    }
    this.volumeUniform.set([rt.width, rt.height, fitRect ? 1 : 0]);
    const radiusPixels = (fitRect ? Math.max(rt.width, rt.height) : Math.min(rt.width, rt.height)) / 2;
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
    const surfaceShader = new PIXI.Shader(terrain, this.#lookUniforms({...shape, uContours: 0}));
    const wireShader = new PIXI.Shader(wireProgram, {...this.#lookUniforms(shape), uWire: 0});
    this.#terrain = {
      geometries: [surface, wire],
      surfaceShader, wireShader,
      meshes: [
        new PIXI.Mesh(surface, surfaceShader, this.state),
        new PIXI.Mesh(wire, wireShader, this.state, PIXI.DRAW_MODES.LINES)
      ]
    };
    this.stage.addChild(...this.#terrain.meshes);
    this.stage.addChild(this.markerLayer.container); // Keep waypoints on top
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
    if ( this.#liveCamera && !this.#dragging && (performance.now() > this.#liveUntil) ) this.#liveCamera = null;
    const camera = this.camera;
    const seconds = game.time.serverTime / 1000;
    this.displayYaw = (camera.yaw + this.spinPhase(look.spin)) % TAU;
    const pitch = Math.clamp(camera.pitch, MIN_PITCH, MAX_PITCH);
    const dist = Math.clamp(camera.dist, MIN_DIST, MAX_DIST);
    this.cameraUniform.set([this.displayYaw, pitch, dist, this.pixelsPerUnit]);
    this.discCameraUniform.set([this.displayYaw, pitch, BASE_DIST, this.pixelsPerUnit]);
    this.targetUniform.set([camera.x, camera.z]);

    this.#flickerTimer -= deltaMS;
    if ( this.#flickerTimer <= 0 ) {
      this.#flickerTimer = 40 + (Math.random() * 120);
      const dropout = Math.random() < 0.04 ? 0.5 : 0;
      this.#flickerTarget = 1 - (look.flicker * ((Math.random() * 0.35) + dropout));
    }
    this.#flicker += (this.#flickerTarget - this.#flicker) * 0.35;

    // The heightmap is owned by Foundry's texture cache; if it was ever evicted, load it again.
    if ( this.#heightmap?.baseTexture?.destroyed ) this.#loadHeightmap(this.#heightmapSrc);
    const showTerrain = !!(this.#terrain && this.#heightmap);
    this.panelMesh.visible = !showTerrain;
    if ( this.#terrain ) for ( const mesh of this.#terrain.meshes ) mesh.visible = showTerrain;

    this.discMesh.visible = look.projector;
    const image = this.#image;
    const shaders = showTerrain ? [this.#terrain.surfaceShader, this.#terrain.wireShader] : [this.panelShader];
    for ( const {uniforms} of shaders ) {
      uniforms.uImage = image;
      uniforms.uTint = look.tint;
      uniforms.uOpacity = look.opacity;
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
      wireShader.uniforms.uWire = terrain.wire;
    }
    const disc = this.discShader.uniforms;
    disc.uOpacity = look.opacity;
    disc.uFlicker = this.#flicker;
    disc.uDashPhase = (seconds * 0.5) % 1;
    this.#layoutMarkers(pitch);
  }

  /** The camera in effect: a live (unsaved) one while being dragged, otherwise the saved one. */
  get camera() {
    return this.#liveCamera ?? this.data.camera;
  }

  /**
   * Show an unsaved camera until a saved change arrives or `hold` ms pass.
   * @param {object} camera
   * @param {number} [hold=5000]
   */
  setLiveCamera(camera, hold=5000) {
    this.#liveCamera = {...this.data.camera, ...camera};
    this.#liveUntil = performance.now() + hold;
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
    return this.pixelsPerUnit * (FOCAL / dist) * (this.tile.document.width / this.renderTexture.width);
  }

  /** @param {PIXI.Renderer} renderer */
  render(renderer) {
    this.#updateGeometry();
    renderer.render(this.stage, {renderTexture: this.renderTexture, clear: true});
  }

  /* -------------------------------------------- */
  /*  Waypoints and picking                       */
  /* -------------------------------------------- */

  /** The waypoints as currently shown, including unsaved drags. */
  get markers() {
    return this.data.annotations.markers.map(m => {
      const live = this.#liveMarkers.get(m.id);
      return live ? {...m, ...live} : m;
    });
  }

  /** @param {string} id @param {{u: number, v: number}|null} position */
  setLiveMarker(id, position) {
    if ( position ) this.#liveMarkers.set(id, position);
    else this.#liveMarkers.delete(id);
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
  #project({x: px, y: py, z: pz}) {
    const [yaw, pitch, dist, ppu] = this.cameraUniform;
    const [tx, tz] = this.targetUniform;
    const [cx, cy] = this.centerUniform;
    px -= tx;
    pz -= tz;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const x = (px * cosY) + (pz * sinY);
    const z1 = (pz * cosY) - (px * sinY);
    const y = (py * cosP) + (z1 * sinP);
    const z = (z1 * cosP) - (py * sinP);
    const w = z + dist;
    if ( w <= 0.05 ) return null;
    const s = (FOCAL * ppu) / w;
    return {x: cx + (x * s), y: cy - (y * s), depth: z};
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
    const rt = this.renderTexture;
    const markers = this.markers;
    const size = Math.clamp(Math.min(rt.width, rt.height) * 0.022, 7, 32);
    this.markerLayer.sync(markers, {size, labels: look.labels, selected: this.selectedMarker});
    for ( const marker of markers ) {
      const surface = this.#surfacePosition(marker.u, marker.v);
      const base = this.#project(surface);
      const head = this.#project({...surface, y: surface.y + STEM_HEIGHT});
      const sprite = this.markerLayer.get(marker.id);
      if ( !base || !head ) {
        sprite.container.visible = false;
        continue;
      }
      const alpha = look.opacity * this.#flicker * this.#volumeAlpha(base) * depthFade(base.depth);
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
    return {x: local.x + (mesh.anchor.x * this.renderTexture.width), y: local.y + (mesh.anchor.y * this.renderTexture.height)};
  }

  /**
   * Convert render-texture pixels of this hologram to a canvas point.
   * @param {{x: number, y: number}} point
   */
  toCanvasPoint(point) {
    const mesh = this.tile.mesh;
    const local = new PIXI.Point(point.x - (mesh.anchor.x * this.renderTexture.width),
      point.y - (mesh.anchor.y * this.renderTexture.height));
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
    this.#textPanel?.destroy();
    this.#destroyTerrain();
    this.markerLayer.destroy();
    this.stage.destroy({children: true});
    destroyGeometries(this.discGeometry, this.panelGeometry);
    this.renderTexture.destroy(true);
  }
}
