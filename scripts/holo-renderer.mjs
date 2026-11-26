import {getHoloData} from "./data.mjs";
import TextPanel from "./text-panel.mjs";

const TAU = Math.PI * 2;
const FOCAL = 2.6;
/** Camera distance at which the projector footprint fills FILL of the tile. */
const BASE_DIST = 4.8;
const FILL = 0.85;
const MIN_DIST = 2.2;
const MAX_RT_SIZE = 2048;
const DISC_RADIUS = 1.08;
/** One scanline per this many scene pixels of tile height. */
const SCANLINE_SPACING = 6;
/** Approximate number of wireframe lines across the terrain in each direction. */
const WIRE_LINES = 40;
const CONTOUR_LEVELS = 12;

/**
 * Projects an object-space point (x right, y up, z away from the default viewer) through the orbit camera.
 * The perspective divide is left to the GPU (w = view depth) so varyings interpolate perspective-correctly.
 */
const PROJECT = `
vec4 project(vec3 p) {
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
uniform vec2 uCenter;`;

/** Shared by the image panel and terrain: hologram colouring of the source image, scanlines and flicker. */
const HOLO_LOOK = `
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
  gl_FragColor = vec4(holo.rgb + uColor * frame * 0.8 * uFlicker, holo.a * uSolidity + frame * 0.2);
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
  fragColor = vec4(holo.rgb + lines, holo.a * uSolidity);
}`;

const WIRE_FRAGMENT = `#version 300 es
precision highp float;
in float vDepth;
in float vHeight;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFlicker;
uniform float uWire;
out vec4 fragColor;

void main() {
  float land = mix(0.15, 1.0, smoothstep(0.01, 0.05, vHeight));
  float depth = mix(1.0, 0.35, clamp((vDepth + 1.0) * 0.5, 0.0, 1.0));
  float a = uWire * uOpacity * uFlicker * land * depth;
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
    this.camera = new Float32Array(4);
    this.center = new Float32Array(2);
    this.color = new Float32Array(3);
    this.state = new PIXI.State();

    const {panel, disc} = getPrograms();
    this.discGeometry = createQuad();
    setQuad(this.discGeometry, DISC_RADIUS, 0, DISC_RADIUS, [-1, 1, 1, 1, 1, -1, -1, -1]);
    this.discShader = new PIXI.Shader(disc, {
      uCamera: this.camera, uCenter: this.center, uColor: this.color,
      uOpacity: 1, uFlicker: 1, uDashPhase: 0
    });
    this.panelGeometry = createQuad();
    this.panelShader = new PIXI.Shader(panel, this.#lookUniforms({uPanelShape: new Float32Array([1, 1])}));
    this.panelMesh = new PIXI.Mesh(this.panelGeometry, this.panelShader, this.state);
    this.discMesh = new PIXI.Mesh(this.discGeometry, this.discShader, this.state);
    this.stage = new PIXI.Container();
    this.stage.addChild(this.discMesh, this.panelMesh);
    this.configure();
  }

  #flicker = 1;
  #flickerTarget = 1;
  #flickerTimer = 0;
  #footprint = "";
  #terrain = null;
  #heightmapSrc = null;
  #heightmap = null;
  /** @type {TextPanel|null} */
  #textPanel = null;

  #lookUniforms(extra={}) {
    return {
      uCamera: this.camera, uCenter: this.center, uColor: this.color, uImage: PIXI.Texture.EMPTY,
      uTint: 0, uOpacity: 1, uSolidity: 1, uScan: 0, uScanDensity: 0, uScanPhase: 0, uFlicker: 1,
      ...extra
    };
  }

  /** Re-read the Tile's flags and size. */
  configure() {
    const data = getHoloData(this.tile.document);
    this.data = data;
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
    this.center.set([w / 2, h / 2]);
    this.scanDensity = (height / SCANLINE_SPACING) / h;
    return changed;
  }

  async #loadHeightmap(src) {
    this.#heightmapSrc = src;
    this.#heightmap = null;
    if ( !src ) return;
    const loadTexture = foundry.canvas.loadTexture ?? globalThis.loadTexture;
    const texture = await loadTexture(src);
    if ( this.#heightmapSrc !== src ) return; // Superseded by a newer request
    if ( !texture ) console.warn(`Vira Holo | Could not load heightmap "${src}"; showing the flat image instead.`);
    this.#heightmap = texture;
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
    const radiusPixels = (fitRect ? Math.max(rt.width, rt.height) : Math.min(rt.width, rt.height)) / 2;
    this.pixelsPerUnit = radiusPixels * FILL / (FOCAL / BASE_DIST);

    const resolution = Math.clamp(Math.round(this.data.terrain.resolution), 16, 256);
    const key = [hx, hz, lift, mode === "terrain" ? resolution : 0].join();
    if ( key === this.#footprint ) return;
    this.#footprint = key;
    setQuad(this.panelGeometry, hx, lift, hz, [0, 0, 1, 0, 1, 1, 0, 1]);
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
    const {camera, look, terrain} = this.data;
    const seconds = game.time.serverTime / 1000;
    const yaw = (camera.yaw + ((seconds * look.spin) % TAU)) % TAU;
    const pitch = Math.clamp(camera.pitch, 0.15, Math.PI / 2);
    const dist = Math.max(camera.dist, MIN_DIST);
    this.camera.set([yaw, pitch, dist, this.pixelsPerUnit]);

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
  }

  /** @param {PIXI.Renderer} renderer */
  render(renderer) {
    this.#updateGeometry();
    renderer.render(this.stage, {renderTexture: this.renderTexture, clear: true});
  }

  destroy() {
    this.#heightmapSrc = null;
    this.#textPanel?.destroy();
    this.#destroyTerrain();
    this.stage.destroy({children: true});
    destroyGeometries(this.discGeometry, this.panelGeometry);
    this.renderTexture.destroy(true);
  }
}
