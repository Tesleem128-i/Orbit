/* ==============================================================
   ORBIT — Three.js CINEMATIC SCENE ENGINE
   (Cinematic upgrade: EnvironmentDirector, LightingDirector,
   MaterialLibrary, OrbitParticleSystem, CameraDirector + shot
   system, AnnotationSystem, QualityManager.)

   Reads a Scene JSON (see ai_pipeline.py SCENE_SYSTEM for the schema)
   and renders + animates it. This file contains NO Groq calls and NO
   knowledge of Flask — it is a pure renderer driven entirely by the
   JSON it's given, per the project's architecture.

   BACKWARD COMPATIBILITY: every field this engine previously read
   (environment.background/fog, camera.fov/position/lookAt, objects,
   timeline, voice, subtitles, lighting.ambient/directional) still
   works exactly as before. New fields are additive and optional:
     environment.theme      — "chemistry" | "biology" | "physics" |
                               "astronomy" | "engineering" |
                               "mathematics" | "business" | "generic"
                               (auto-detected from object types if omitted)
     environment.particles  — { count, color } override
     shots[]                — [{ id, start, duration, camera:{action,...} }]
                               layered on top of the existing timeline;
                               the old cameraZoom/cameraPan/cameraRotate
                               timeline actions still work unchanged.
   The public API (constructor signature, .ready, .play/.pause/.restart/
   .seekFraction/.setSpeed/.setVoiceSpeed/.dispose, .rendererKind, and
   the onProgress/onSubtitle/onEnd callbacks) is unchanged, so player.js
   and lesson.html need no changes.

   RENDERER STRATEGY: unchanged — WebGPURenderer first, WebGL2 fallback
   on any failure. See _initRenderer / _setupWebGPUPath / _setupWebGLFallbackPath.
   ============================================================== */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
// WebGPU + TSL are loaded dynamically inside _setupWebGPUPath's try/catch,
// NOT as static imports — a static import failure (wrong CDN path, browser
// without WebGPU module support, etc.) would kill the entire module before
// any fallback code could run. A dynamic import() failure is just a
// rejected promise, which the try/catch around it can actually catch.

function hashPhase(id) {
  let hash = 0;
  const str = String(id || "");
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 1000;
  return (hash / 1000) * Math.PI * 2;
}

/* ==============================================================
   Procedural generation helpers — pure deterministic math, no
   external noise library dependency, so the same object id always
   generates the same tree/terrain (cacheable, reproducible), per
   the architecture doc's "every actor is independently seedable"
   principle.
   ============================================================== */
function seedFromId(id) {
  let h = 0;
  const str = String(id || "seed");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 100000) / 100000;
}

function mulberry32(seed) {
  let a = Math.floor(seed * 4294967296) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2D(x, y, seed) {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return h - Math.floor(h);
}

function valueNoise2D(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2D(xi, yi, seed), b = hash2D(xi + 1, yi, seed);
  const c = hash2D(xi, yi + 1, seed), d = hash2D(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fractalNoise2D(x, y, seed, octaves = 4) {
  let value = 0, amplitude = 0.5, frequency = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise2D(x * frequency, y * frequency, seed + i * 17.13) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / max;
}

const PALETTE = ["#C9A24C", "#5FA08C", "#C1633B", "#8A7137", "#B9C0CC", "#DAB463"];

/* ==============================================================
   Tween — tiny time-based animation helper
   ============================================================== */
class Tween {
  constructor(duration, onUpdate, onComplete, targetId = null) {
    this.duration = duration;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.targetId = targetId;
    this.t = 0;
    this._done = false;
  }
  step(delta) {
    if (this._done) return true;
    this.t += delta;
    const frac = Math.min(this.t / this.duration, 1);
    this.onUpdate(frac);
    if (frac >= 1) {
      this._done = true;
      if (this.onComplete) this.onComplete();
      return true;
    }
    return false;
  }
  static easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  static easeInQuad(t) { return t * t; }
  static easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  static easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}

/* ==============================================================
   Small canvas helpers shared by TextSprite / AnnotationSystem /
   the particle-halo sprites.
   ============================================================== */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function colorToRgba(hexOrColor, alpha) {
  const c = new THREE.Color(hexOrColor);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${alpha})`;
}

function makeHaloSprite(color, size = 1, opacity = 0.55) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, colorToRgba(color, opacity));
  g.addColorStop(1, colorToRgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1);
  return sprite;
}

/* ==============================================================
   TextSprite — small billboard text, used for compact in-scene
   labels (chart bars, process-flow node ids) where a full callout
   card would be visual clutter.
   ============================================================== */
const TextSprite = {
  make(text, color = "#F3EEE1") {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fontSize = 46;
    ctx.font = `600 ${fontSize}px Sora, sans-serif`;
    const metrics = ctx.measureText(text);
    canvas.width = Math.ceil(metrics.width) + 40;
    canvas.height = fontSize + 32;

    ctx.font = `600 ${fontSize}px Sora, sans-serif`;
    ctx.fillStyle = "rgba(14,26,43,0.72)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 20, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    const scaleFactor = canvas.width / canvas.height;
    sprite.scale.set(scaleFactor * 0.7, 0.7, 1);
    return sprite;
  },
};

/* ==============================================================
   AnnotationSystem — premium callout labels: a rounded card with
   an accent border plus a thin leader line back to the anchor
   point, instead of a flat floating debug box. Used for object
   labels and molecule atom labels. Appears/animates via .reveal().
   ============================================================== */
const AnnotationSystem = {
  makeCallout(text, opts = {}) {
    const color = opts.color || "#F3EEE1";
    const accent = opts.accent || "#C9A24C";
    const scale = opts.scale || 0.42;
    const offset = opts.offset || new THREE.Vector3(0, 0.75, 0);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fontSize = 34;
    ctx.font = `600 ${fontSize}px Sora, sans-serif`;
    const metrics = ctx.measureText(text);
    const padX = 26, padY = 16;
    canvas.width = Math.ceil(metrics.width) + padX * 2;
    canvas.height = fontSize + padY * 2;

    ctx.font = `600 ${fontSize}px Sora, sans-serif`;
    roundRectPath(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 12);
    ctx.fillStyle = "rgba(7,13,22,0.80)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, padX, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    const scaleFactor = canvas.width / canvas.height;
    sprite.scale.set(scaleFactor * scale, scale, 1);
    sprite.position.copy(offset);

    const leaderEnd = offset.clone();
    leaderEnd.y -= scale * 0.42;
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.02, 0), leaderEnd]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.5 }));

    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), new THREE.MeshBasicMaterial({ color: accent }));

    const group = new THREE.Group();
    group.add(line, sprite, dot);
    group.userData.isAnnotation = true;
    return group;
  },

  // A single equation "chip" — one token of a formula (a symbol, an
  // operator, a subscript-style label) rendered as its own small sprite
  // so a scene can highlight/pulse just that term (e.g. "F" in σ = F/A)
  // instead of the whole equation flashing at once.
  makeToken(text, opts = {}) {
    const color = opts.color || "#F3EEE1";
    const accent = opts.accent || "#C9A24C";
    const emphasis = !!opts.emphasis; // symbols get a bordered chip; operators are bare
    const scale = opts.scale || 0.5;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fontSize = 44;
    ctx.font = `700 ${fontSize}px Sora, sans-serif`;
    const metrics = ctx.measureText(text);
    const padX = emphasis ? 22 : 8, padY = 12;
    canvas.width = Math.ceil(metrics.width) + padX * 2;
    canvas.height = fontSize + padY * 2;
    ctx.font = `700 ${fontSize}px Sora, sans-serif`;

    if (emphasis) {
      roundRectPath(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 10);
      ctx.fillStyle = "rgba(7,13,22,0.72)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
    ctx.fillStyle = emphasis ? accent : color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, padX, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    const scaleFactor = canvas.width / canvas.height;
    sprite.scale.set(scaleFactor * scale, scale, 1);
    sprite.userData.tokenWidth = scaleFactor * scale;
    sprite.userData.token = opts.token || text;
    return sprite;
  },
};

/* ==============================================================
   Sky — a soft vertical gradient used as scene.background, instead
   of a flat hex fill, for a more atmospheric backdrop.
   ============================================================== */
function makeSkyTexture(topColor, bottomColor) {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(1, bottomColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function lighten(hex, amount) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, hsl.l + amount));
  return `#${c.getHexString()}`;
}

/* ==============================================================
   QualityManager — detects a sensible LOW/MEDIUM/HIGH tier from
   the device so particle counts, shadows, DPR and bloom strength
   degrade gracefully on ordinary student laptops / phones instead
   of tanking frame rate. The user's explicit choice (if any) wins.
   ============================================================== */
class QualityManager {
  constructor(forcedTier = null) {
    const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "");
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;

    let tier = "high";
    if (mobile || cores <= 4 || mem <= 4) tier = "medium";
    if (mobile && (cores <= 4 || mem <= 2)) tier = "low";
    this.tier = forcedTier || tier;
    this.setTier(this.tier);
  }
  setTier(tier) {
    this.tier = tier;
    const table = {
      low: { particleMultiplier: 0.3, dprCap: 1.25, shadows: false, bloomStrength: 0.32, shadowMapSize: 512 },
      medium: { particleMultiplier: 0.6, dprCap: 1.75, shadows: true, bloomStrength: 0.45, shadowMapSize: 1024 },
      high: { particleMultiplier: 1.0, dprCap: 2.0, shadows: true, bloomStrength: 0.55, shadowMapSize: 1024 },
    };
    Object.assign(this, table[tier] || table.medium);
  }
}

/* ==============================================================
   MaterialLibrary — reusable, physically-motivated material
   presets so the engine stops leaning on one generic
   MeshPhysicalMaterial for every subject.
   ============================================================== */
const MaterialLibrary = {
  get(preset, color = "#C9A24C", overrides = {}) {
    const base = { color };
    switch (preset) {
      case "glass":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.04, metalness: 0, transmission: 0.92, thickness: 0.6, ior: 1.5, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2, transparent: true, ...overrides });
      case "water":
        return new THREE.MeshPhysicalMaterial({ color: color || "#3f7fb0", roughness: 0.08, metalness: 0, transmission: 0.85, thickness: 0.8, ior: 1.33, clearcoat: 0.6, envMapIntensity: 1.3, transparent: true, ...overrides });
      case "ice":
        return new THREE.MeshPhysicalMaterial({ color: color || "#d8ecf5", roughness: 0.18, metalness: 0, transmission: 0.6, thickness: 0.5, ior: 1.31, clearcoat: 0.5, envMapIntensity: 1.1, transparent: true, ...overrides });
      case "metal":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.28, metalness: 1, clearcoat: 0.2, envMapIntensity: 1.4, ...overrides });
      case "rubber":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.92, metalness: 0, clearcoat: 0, ...overrides });
      case "ceramic":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25, ...overrides });
      case "organic":
      case "skin":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.62, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.5, ...overrides });
      case "crystal":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.05, metalness: 0, transmission: 0.7, ior: 1.9, clearcoat: 1, envMapIntensity: 1.3, transparent: true, ...overrides });
      case "energy":
      case "plasma":
      case "glowing":
        return new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 2.0, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.9, ...overrides });
      case "holographic":
        return new THREE.MeshPhysicalMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.35, side: THREE.DoubleSide, ...overrides });
      case "scientificAtom":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.22, metalness: 0.12, clearcoat: 0.45, clearcoatRoughness: 0.25, envMapIntensity: 1.1, ...overrides });
      default:
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.45, metalness: 0.25, clearcoat: 0.15, clearcoatRoughness: 0.4, ...overrides });
    }
  },
};

/* ==============================================================
   OrbitParticleSystem — a single performant Points cloud (one
   BufferGeometry, one draw call) used for ambient atmosphere:
   dust, molecular particles, stars, embers, data motes, etc.
   Never spawns per-particle Mesh objects.
   ============================================================== */
class OrbitParticleSystem {
  constructor(scene, opts = {}) {
    const {
      count = 200, color = "#8fb3d9", spread = 14, spreadY = null,
      size = 0.035, opacity = 0.55, speed = 0.15, shape = "box",
    } = opts;

    this.count = Math.max(0, Math.round(count));
    this.speed = speed;
    this.scene = scene;

    const positions = new Float32Array(this.count * 3);
    const seeds = new Float32Array(this.count);
    const sy = spreadY == null ? spread * 0.6 : spreadY;

    for (let i = 0; i < this.count; i++) {
      if (shape === "sphere") {
        const r = spread * Math.cbrt(Math.random());
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.cos(phi) * 0.6;
        positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      } else {
        positions[i * 3] = (Math.random() - 0.5) * spread * 2;
        positions[i * 3 + 1] = (Math.random() - 0.5) * sy * 2;
        positions[i * 3 + 2] = (Math.random() - 0.5) * spread * 2;
      }
      seeds[i] = Math.random() * 100;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.basePositions = positions.slice();
    this.seeds = seeds;

    const material = new THREE.PointsMaterial({
      color, size, transparent: true, opacity, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    if (this.count > 0) scene.add(this.points);
  }

  update(elapsed) {
    if (!this.count) return;
    const pos = this.points.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < this.count; i++) {
      const s = this.seeds[i];
      arr[i * 3 + 1] = this.basePositions[i * 3 + 1] + Math.sin(elapsed * this.speed + s) * 0.4;
      arr[i * 3] = this.basePositions[i * 3] + Math.sin(elapsed * this.speed * 0.6 + s * 1.7) * 0.15;
    }
    pos.needsUpdate = true;
    this.points.rotation.y += 0.00025;
  }

  dispose() {
    if (!this.count) return;
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

/* ==============================================================
   EnvironmentDirector — replaces the old "grid floor on every
   lesson" default with a contextual environment chosen from
   sceneData.environment.theme (or auto-detected from the objects
   present). Builds background gradient, fog, an optional subtle
   floor (only where a floor actually makes sense), and the
   themed ambient particle field.
   ============================================================== */
const ENVIRONMENT_THEMES = {
  chemistry: { bgTop: "#0d1c33", bgBottom: "#04070d", fog: true, fogNear: 6, fogFar: 24, particleColor: "#6fa9ff", particleCount: 260, floor: "none" },
  biology: { bgTop: "#0a2420", bgBottom: "#020806", fog: true, fogNear: 5, fogFar: 20, particleColor: "#7fd9a0", particleCount: 220, floor: "none" },
  physics: { bgTop: "#150a26", bgBottom: "#040309", fog: true, fogNear: 6, fogFar: 26, particleColor: "#b98fff", particleCount: 200, floor: "none" },
  astronomy: { bgTop: "#03050d", bgBottom: "#000000", fog: false, particleColor: "#ffffff", particleCount: 420, floor: "none", spread: 40 },
  engineering: { bgTop: "#1a1a1e", bgBottom: "#0a0a0c", fog: false, particleColor: "#c9a24c", particleCount: 50, floor: "studio" },
  mathematics: { bgTop: "#0c0c1a", bgBottom: "#020204", fog: true, fogNear: 8, fogFar: 28, particleColor: "#8fa0ff", particleCount: 150, floor: "grid-thin" },
  business: { bgTop: "#0a1420", bgBottom: "#03060a", fog: false, particleColor: "#c9a24c", particleCount: 110, floor: "grid-thin" },
  generic: { bgTop: "#0e1a2b", bgBottom: "#050b14", fog: true, fogNear: 9, fogFar: 27, particleColor: "#8fb3d9", particleCount: 150, floor: "grid-thin" },
};

const EnvironmentDirector = {
  detectTheme(sceneData) {
    const explicit = sceneData.environment && sceneData.environment.theme;
    if (explicit && ENVIRONMENT_THEMES[explicit]) return explicit;
    const types = (sceneData.objects || []).map((o) => o.type);
    if (types.includes("molecule")) return "chemistry";
    if (types.includes("terrain") || types.includes("tree")) return "biology";
    if (types.includes("graph_bar") || types.includes("graph_line") || types.includes("pie_chart") || types.includes("process_flow")) return "business";
    if (types.includes("robot") || types.includes("car") || types.includes("building") || types.includes("table") || types.includes("chair") || types.includes("beam") || types.includes("force_vector") || types.includes("cross_section")) return "engineering";
    return "generic";
  },

  build(engine) {
    const sceneData = engine.sceneData;
    const theme = this.detectTheme(sceneData);
    const cfg = ENVIRONMENT_THEMES[theme] || ENVIRONMENT_THEMES.generic;
    const envCfg = sceneData.environment || {};

    const bottom = envCfg.background || cfg.bgBottom;
    const top = envCfg.background ? lighten(envCfg.background, 0.08) : cfg.bgTop;
    engine.scene.background = makeSkyTexture(top, bottom);

    const fogOn = envCfg.fog !== undefined ? envCfg.fog : cfg.fog;
    if (fogOn) engine.scene.fog = new THREE.Fog(new THREE.Color(bottom), cfg.fogNear || 9, cfg.fogFar || 27);
    else engine.scene.fog = null;

    // Floor: only where the subject actually calls for a surface to
    // stand on. Pure scientific/atmospheric subjects get none — the
    // old "every lesson sits on a big glowing grid" look is gone.
    if (cfg.floor === "grid-thin") {
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(14, 56),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(bottom).multiplyScalar(0.6), roughness: 0.95, metalness: 0.05 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.01;
      ground.receiveShadow = true;
      engine.scene.add(ground);
      const grid = new THREE.GridHelper(28, 28, 0x2f4a6e, 0x172033);
      grid.material.transparent = true;
      grid.material.opacity = 0.22;
      engine.scene.add(grid);
      engine._envMeshes.push(ground, grid);
    } else if (cfg.floor === "studio") {
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(12, 56),
        new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.75, metalness: 0.1 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.01;
      ground.receiveShadow = true;
      engine.scene.add(ground);
      engine._envMeshes.push(ground);
    }

    // A slow-rotating brass ring — a quiet nod to Orbit's own identity,
    // kept subtle and far from the subject so it never competes for focus.
    const brandRing = new THREE.Mesh(
      new THREE.TorusGeometry(15, 0.015, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0xc9a24c, transparent: true, opacity: 0.14 })
    );
    brandRing.rotation.x = Math.PI / 2;
    engine.scene.add(brandRing);
    engine.brandRing = brandRing;

    // Ambient particle field
    const particleCfg = envCfg.particles || {};
    const count = Math.round((particleCfg.count ?? cfg.particleCount) * engine.quality.particleMultiplier);
    engine.ambientParticles = new OrbitParticleSystem(engine.scene, {
      count, color: particleCfg.color || cfg.particleColor,
      spread: cfg.spread || 13, size: theme === "astronomy" ? 0.045 : 0.03,
      opacity: 0.5, speed: 0.18, shape: theme === "astronomy" ? "sphere" : "box",
    });

    engine.environmentTheme = theme;
    return theme;
  },
};

/* ==============================================================
   LightingDirector — a real key/fill/rim/top rig instead of a
   flat ambient wash, so every subject gets a readable silhouette,
   rim separation and controlled contrast. Existing lighting.ambient
   / lighting.directional scene-JSON fields are still honored and
   layered on top for backward compatibility.
   ============================================================== */
const LightingDirector = {
  build(engine) {
    const scene = engine.scene;
    const lighting = engine.sceneData.lighting || {};
    const theme = engine.environmentTheme || "generic";

    const themeTint = {
      chemistry: "#6fa9ff", biology: "#7fd9a0", physics: "#b98fff",
      astronomy: "#dfe8ff", engineering: "#c9a24c", mathematics: "#8fa0ff",
      business: "#c9a24c", generic: "#c9a24c",
    }[theme] || "#c9a24c";

    // Fill — soft hemisphere so shadow sides are never pure black
    scene.add(new THREE.HemisphereLight(0x8fb3d9, 0x101826, 0.32));

    // Legacy ambient field (old scene JSON) — kept low so it doesn't
    // flatten the new rig's contrast.
    if (lighting.ambient) {
      scene.add(new THREE.AmbientLight(new THREE.Color(lighting.ambient.color || "#ffffff"), (lighting.ambient.intensity ?? 0.5) * 0.35));
    }

    // Key — warm, shadow-casting, the dominant light
    const key = new THREE.DirectionalLight(0xfff2df, 1.15);
    key.position.set(6, 9, 6);
    if (engine.quality.shadows) {
      key.castShadow = true;
      key.shadow.mapSize.set(engine.quality.shadowMapSize, engine.quality.shadowMapSize);
      key.shadow.camera.left = -10; key.shadow.camera.right = 10;
      key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
      key.shadow.bias = -0.0015;
    }
    scene.add(key);

    // Rim — cool, opposite the key, for silhouette separation
    const rim = new THREE.DirectionalLight(new THREE.Color(themeTint), 0.65);
    rim.position.set(-7, 4, -6);
    scene.add(rim);

    // Top — soft downward point light for contact highlights
    const top = new THREE.PointLight(0xffffff, 0.35, 22, 2);
    top.position.set(0, 9, 2);
    scene.add(top);

    // Legacy directional lights array (old scene JSON) still honored
    (lighting.directional || []).forEach((d) => {
      const light = new THREE.DirectionalLight(new THREE.Color(d.color || "#ffffff"), (d.intensity ?? 0.8) * 0.7);
      light.position.set(...(d.position || [5, 8, 5]));
      scene.add(light);
    });

    engine._keyLight = key;
  },
};

/* ==============================================================
   ObjectFactory — maps a scene object's `type` to a THREE.Object3D
   ============================================================== */
const ObjectFactory = {
  build(obj) {
    const color = obj.color || "#C9A24C";
    const material = (opts = {}) => MaterialLibrary.get(obj.material || "default", color, opts);

    switch (obj.type) {
      case "box":
        return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2), material());
      case "sphere":
        return new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 32), material({ roughness: 0.3, metalness: 0.35 }));
      case "cylinder":
        return new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 28), material());
      case "cone":
        return new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 28), material());
      case "torus":
        return new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.22, 20, 48), material({ metalness: 0.5, roughness: 0.25 }));
      case "plane":
        return new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }));
      case "arrow":
        return this._arrow(color);
      case "line":
        return this._line(obj, color);
      case "text":
        return this._textBlock(obj, color);
      case "graph_bar":
        return this._graphBar(obj);
      case "graph_line":
        return this._graphLine(obj, color);
      case "pie_chart":
        return this._pieChart(obj);
      case "character":
        return this._character(color);
      case "building":
        return this._building(color);
      case "tree":
        return this._tree(obj);
      case "robot":
        return this._robot(color);
      case "car":
        return this._car(color);
      case "book":
        return this._book(color);
      case "table":
        return this._table(color);
      case "chair":
        return this._chair(color);
      case "icon":
        return this._icon(obj, color);
      case "process_flow":
        return this._processFlow(obj);
      case "molecule":
        return this._molecule(obj);
      case "terrain":
        return this._terrain(obj);
      case "beam":
        return this._beam(obj);
      case "force_vector":
        return this._forceVector(obj);
      case "cross_section":
        return this._crossSection(obj);
      case "formula":
        return this._formula(obj);
      default: {
        const shapes = [
          () => new THREE.SphereGeometry(0.6, 28, 28),
          () => new THREE.CylinderGeometry(0.5, 0.5, 1.2, 24),
          () => new THREE.TorusGeometry(0.6, 0.2, 16, 40),
          () => new THREE.ConeGeometry(0.6, 1.2, 24),
          () => new THREE.IcosahedronGeometry(0.65, 1),
        ];
        const pick = shapes[Math.abs(Math.round(hashPhase(obj.id) * 1000)) % shapes.length];
        return new THREE.Mesh(pick(), material());
      }
    }
  },

  approxHeight(obj) {
    const tall = new Set(["character", "building", "tree", "robot", "table", "chair", "cylinder", "cone", "beam", "force_vector"]);
    return tall.has(obj.type) ? 2 : 1.2;
  },

  _arrow(color) {
    const group = new THREE.Group();
    const shaftMat = new THREE.MeshPhysicalMaterial({ color, metalness: 0.4, roughness: 0.3 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2, 16), shaftMat);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = -0.2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 20), shaftMat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = 0.6;
    group.add(shaft, head);
    return group;
  },

  _line(obj, color) {
    const points = (obj.points && obj.points.length >= 2)
      ? obj.points.map((p) => new THREE.Vector3(...p))
      : [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
  },

  _textBlock(obj, color) {
    const group = new THREE.Group();
    const sprite = TextSprite.make(obj.text || obj.label || "", color === "#C9A24C" ? "#F3EEE1" : color);
    group.add(sprite);
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial({ visible: false }));
    group.add(hitbox);
    return group;
  },

  _graphBar(obj) {
    const group = new THREE.Group();
    const data = (obj.data && obj.data.length) ? obj.data : [{ label: "A", value: 1 }, { label: "B", value: 2 }];
    const maxVal = Math.max(...data.map((d) => d.value), 1);
    const unitHeight = 2 / maxVal;
    data.forEach((d, i) => {
      const fullHeight = Math.max(0.05, d.value * unitHeight);
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 1, 0.5),
        new THREE.MeshPhysicalMaterial({ color: PALETTE[i % PALETTE.length], metalness: 0.2, roughness: 0.4 })
      );
      bar.position.set(i * 0.7 - (data.length - 1) * 0.35, fullHeight / 2, 0);
      bar.scale.y = fullHeight;
      bar.userData.isGraphBar = true;
      bar.userData.fullHeight = fullHeight;
      bar.userData.unitHeight = fullHeight;
      const label = TextSprite.make(String(d.label), "#F3EEE1");
      label.position.set(0, 0.9, 0);
      label.scale.multiplyScalar(0.5);
      bar.add(label);
      group.add(bar);
    });
    return group;
  },

  _graphLine(obj, color) {
    const data = (obj.data && obj.data.length) ? obj.data : [{ label: "A", value: 1 }, { label: "B", value: 2 }];
    const maxVal = Math.max(...data.map((d) => d.value), 1);
    const points = data.map((d, i) => new THREE.Vector3(i * 0.8 - (data.length - 1) * 0.4, (d.value / maxVal) * 2, 0));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 3 }));
    const group = new THREE.Group();
    group.add(line);
    points.forEach((p) => {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), new THREE.MeshPhysicalMaterial({ color, metalness: 0.4, roughness: 0.2 }));
      dot.position.copy(p);
      group.add(dot);
    });
    return group;
  },

  _pieChart(obj) {
    const group = new THREE.Group();
    const data = (obj.data && obj.data.length) ? obj.data : [{ label: "A", value: 1 }, { label: "B", value: 1 }];
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    let angle = 0;
    data.forEach((d, i) => {
      const slice = (d.value / total) * Math.PI * 2;
      const geometry = new THREE.CircleGeometry(0.9, 32, angle, slice);
      const mat = new THREE.MeshPhysicalMaterial({ color: PALETTE[i % PALETTE.length], side: THREE.DoubleSide, roughness: 0.4, metalness: 0.15 });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.userData.isPieSlice = true;
      group.add(mesh);
      angle += slice;
    });
    return group;
  },

  _character(color) {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, metalness: 0.05 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 6, 16), bodyMat);
    body.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 20), new THREE.MeshPhysicalMaterial({ color: "#E8C89A", roughness: 0.6 }));
    head.position.y = 1.55;
    group.add(body, head);
    return group;
  },

  _building(color) {
    const group = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(1.2 - i * 0.15, 0.7, 1.2 - i * 0.15),
        new THREE.MeshPhysicalMaterial({ color, roughness: 0.5, metalness: 0.1 })
      );
      floor.position.y = i * 0.72 + 0.35;
      group.add(floor);
    }
    return group;
  },

  _tree(obj) {
    const group = new THREE.Group();
    const seed = seedFromId(obj && obj.id);
    const rng = mulberry32(seed);
    const trunkMat = new THREE.MeshStandardMaterial({ color: "#6B4A2E", roughness: 0.9 });
    const leafMat = new THREE.MeshStandardMaterial({ color: "#5FA08C", roughness: 0.8 });
    const up = new THREE.Vector3(0, 1, 0);

    const branch = (origin, direction, length, radius, depth) => {
      if (depth > 4 || length < 0.06) {
        const leafCount = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < leafCount; i++) {
          const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.15 + rng() * 0.1, 10, 10), leafMat);
          leaf.position.copy(origin).addScaledVector(direction, length * 0.5);
          leaf.position.x += (rng() - 0.5) * 0.2;
          leaf.position.z += (rng() - 0.5) * 0.2;
          group.add(leaf);
        }
        return;
      }

      const end = origin.clone().addScaledVector(direction, length);
      const mid = origin.clone().lerp(end, 0.5);
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.7, radius, length, 8), trunkMat);
      segment.position.copy(mid);
      segment.quaternion.setFromUnitVectors(up, direction.clone().normalize());
      group.add(segment);

      const childCount = depth === 0 ? 3 : 2 + Math.floor(rng() * 2);
      for (let i = 0; i < childCount; i++) {
        const angle = (i / childCount) * Math.PI * 2 + rng() * 0.6;
        const tilt = 0.35 + rng() * 0.35;
        const childDir = direction.clone()
          .applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt * Math.cos(angle))
          .applyAxisAngle(new THREE.Vector3(0, 0, 1), tilt * Math.sin(angle))
          .normalize();
        branch(end, childDir, length * (0.62 + rng() * 0.12), radius * 0.62, depth + 1);
      }
    };

    branch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 0.75, 0.14, 0);
    return group;
  },

  _terrain(obj) {
    const size = 3.2, segments = 26;
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const seed = seedFromId(obj.id) * 1000;
    const heightScale = (obj.params && obj.params.heightScale) || 0.6;

    const positions = geometry.attributes.position;
    const colors = [];
    const lowColor = new THREE.Color("#3f6b4a");
    const midColor = new THREE.Color("#8a7a5a");
    const highColor = new THREE.Color("#eef2f5");

    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), z = positions.getZ(i);
      const n = fractalNoise2D((x / size) * 3 + 10, (z / size) * 3 + 10, seed);
      const height = n * heightScale;
      positions.setY(i, height);
      const t = Math.min(1, Math.max(0, height / heightScale));
      const c = t < 0.5 ? lowColor.clone().lerp(midColor, t * 2) : midColor.clone().lerp(highColor, (t - 0.5) * 2);
      colors.push(c.r, c.g, c.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.04 }));
  },

  // ------------------------------------------------------------
  // Engineering / structural primitives
  // ------------------------------------------------------------

  /** A structural beam/rod/column/plate/shaft — one primitive covers all of
   * these via obj.shape, since they're all "a prismatic member under load"
   * visually. Optional end supports (obj.supports) read as fixed anchors. */
  _beam(obj) {
    const group = new THREE.Group();
    const color = obj.color || "#B9C0CC";
    const matPreset = obj.material || "metal";
    const dims = obj.dimensions || {};
    const length = dims.length || 3.2;
    const shape = obj.shape || "rect"; // "rect" | "round"

    let mesh;
    if (shape === "round") {
      const radius = dims.radius || 0.32;
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, length, 32),
        MaterialLibrary.get(matPreset, color, { roughness: 0.3, metalness: matPreset === "metal" ? 0.7 : 0.1 })
      );
      mesh.rotation.z = Math.PI / 2;
    } else {
      const w = dims.width || 0.6, h = dims.height || 0.6;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(length, h, w, 12, 4, 4),
        MaterialLibrary.get(matPreset, color, { roughness: 0.35, metalness: matPreset === "metal" ? 0.65 : 0.1 })
      );
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.isBeamCore = true;
    mesh.userData.beamLength = length;
    group.add(mesh);

    if (obj.supports) {
      const supportMat = MaterialLibrary.get("ceramic", "#3a3f47", { roughness: 0.6 });
      [-1, 1].forEach((side) => {
        const support = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.7), supportMat);
        support.position.set(side * (length / 2 - 0.1), -0.5, 0);
        support.castShadow = true;
        group.add(support);
      });
    }

    group.userData.isBeam = true;
    return group;
  },

  /** A labeled, magnitude-scaled force/moment arrow — distinct from the
   * generic flow "arrow" type in that it always carries a value + label,
   * per the "force vectors must look like scientific diagram objects"
   * requirement. */
  _forceVector(obj) {
    const group = new THREE.Group();
    const color = obj.color || "#C1633B";
    const magnitude = Math.max(0.3, obj.magnitude || 1);
    const length = 0.9 + magnitude * 0.6;
    const dir = new THREE.Vector3(...(obj.direction || [1, 0, 0])).normalize();

    const mat = MaterialLibrary.get("metal", color, { roughness: 0.25, metalness: 0.55, emissive: new THREE.Color(color), emissiveIntensity: 0.25 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, length, 16), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 20), mat);
    shaft.position.y = length / 2;
    head.position.y = length + 0.15;
    group.add(shaft, head);

    // A thin additive glow sleeve reads as "scientific" rather than a plain rod
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, length, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.position.y = length / 2;
    group.add(glow);

    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    const labelText = obj.label || (obj.magnitudeLabel ? obj.magnitudeLabel : null);
    if (labelText) {
      const callout = AnnotationSystem.makeCallout(labelText, {
        accent: `#${new THREE.Color(color).getHexString()}`,
        offset: new THREE.Vector3(0, length + 0.55, 0), scale: 0.3,
      });
      // Counter-rotate the label so it stays upright regardless of vector direction
      callout.quaternion.copy(group.quaternion.clone().invert());
      group.add(callout);
    }

    group.userData.isForceVector = true;
    return group;
  },

  /** A cross-section cut plane with an optional distributed stress field —
   * the actual educational payload for normal/shear/bending/torsion stress,
   * instead of coloring the whole object red. Hidden by default; revealed
   * via the "revealCrossSection" timeline action. */
  _crossSection(obj) {
    const group = new THREE.Group();
    const shape = obj.shape || "circle";
    const size = obj.size || 1.1;
    const color = obj.color || "#8fd0ff";

    const planeGeo = shape === "rect"
      ? new THREE.PlaneGeometry(size, size * 0.7)
      : new THREE.CircleGeometry(size * 0.5, 40);
    const plane = new THREE.Mesh(planeGeo, MaterialLibrary.get("glass", color, { transmission: 0.55, opacity: 0.5, side: THREE.DoubleSide }));
    plane.rotation.x = Math.PI / 2; // face along the member's axis by default; obj.rotation still applies on top
    group.add(plane);

    const rimLines = shape === "rect"
      ? new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }))
      : new THREE.Mesh(new THREE.TorusGeometry(size * 0.5, 0.012, 8, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    rimLines.rotation.x = Math.PI / 2;
    group.add(rimLines);

    // Distributed internal force field — this IS the stress visualization.
    const pattern = obj.stressPattern || "uniform"; // uniform | bending | shear | torsion
    const intensity = obj.intensity ?? 1;
    const fieldGroup = new THREE.Group();
    const arrowMat = new THREE.MeshBasicMaterial({ color: "#ff9d5c", transparent: true, opacity: 0.9 });
    const makeMiniArrow = (len) => {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 8), arrowMat);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 10), arrowMat);
      shaft.position.y = len / 2;
      head.position.y = len + 0.03;
      g.add(shaft, head);
      return g;
    };

    const r = size * 0.5 * 0.75;
    if (pattern === "uniform") {
      for (let gx = -1; gx <= 1; gx++) {
        for (let gy = -1; gy <= 1; gy++) {
          const arrow = makeMiniArrow(0.28 * intensity);
          arrow.position.set(gx * r * 0.6, 0.02, gy * r * 0.6);
          arrow.rotation.x = -Math.PI / 2;
          fieldGroup.add(arrow);
        }
      }
    } else if (pattern === "bending") {
      for (let i = -2; i <= 2; i++) {
        const t = i / 2; // -1 (bottom) .. 1 (top)
        const len = Math.max(0.08, Math.abs(t) * 0.4 * intensity);
        const arrow = makeMiniArrow(len);
        arrow.position.set(0, 0.02, t * r);
        arrow.rotation.x = t > 0 ? Math.PI / 2 : -Math.PI / 2; // tension out, compression in
        fieldGroup.add(arrow);
      }
    } else if (pattern === "shear" || pattern === "torsion") {
      const count = 6;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const arrow = makeMiniArrow(0.24 * intensity);
        arrow.position.set(Math.cos(angle) * r * 0.7, 0.02, Math.sin(angle) * r * 0.7);
        arrow.rotation.x = -Math.PI / 2;
        arrow.rotation.y = angle + Math.PI / 2; // tangential
        fieldGroup.add(arrow);
      }
    }
    fieldGroup.visible = true;
    group.add(fieldGroup);

    group.userData.isCrossSection = true;
    group.userData.stressField = fieldGroup;
    group.visible = false; // revealed via "revealCrossSection"
    return group;
  },

  /** A premium equation panel — individual token chips laid out in a row
   * (see AnnotationSystem.makeToken) so a single term can be highlighted
   * in sync with narration via the "highlightTerm" action, instead of one
   * flat floating label. */
  _formula(obj) {
    const group = new THREE.Group();
    const accent = obj.color || "#C9A24C";
    const rawTokens = (obj.terms && obj.terms.length)
      ? obj.terms.map((t) => (typeof t === "string" ? t : t.symbol))
      : String(obj.expression || "").split(/\s+/).filter(Boolean);
    const tokens = rawTokens.length ? rawTokens : ["?"];

    const operators = new Set(["=", "+", "-", "/", "*", "×", "÷", "(", ")"]);
    let cursor = 0;
    const gap = 0.14;
    const chips = [];
    tokens.forEach((tok) => {
      const emphasis = !operators.has(tok);
      const chip = AnnotationSystem.makeToken(tok, { accent, emphasis, scale: emphasis ? 0.52 : 0.4, token: tok });
      chips.push(chip);
    });
    const totalWidth = chips.reduce((s, c) => s + c.userData.tokenWidth, 0) + gap * (chips.length - 1);
    let x = -totalWidth / 2;
    chips.forEach((chip) => {
      chip.position.x = x + chip.userData.tokenWidth / 2;
      x += chip.userData.tokenWidth + gap;
      chip.userData.baseScale = chip.scale.clone();
      group.add(chip);
    });

    // Soft backing panel so the equation reads as one integrated object
    const panelW = totalWidth + 0.5, panelH = 0.85;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW, panelH),
      new THREE.MeshBasicMaterial({ color: "#070d16", transparent: true, opacity: 0.55 })
    );
    panel.position.z = -0.02;
    group.add(panel);
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(panelW, panelH)),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.5 })
    );
    border.position.z = -0.02;
    group.add(border);

    group.userData.isFormula = true;
    group.userData.tokenChips = chips;
    return group;
  },

  _robot(color) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.4), new THREE.MeshPhysicalMaterial({ color, metalness: 0.6, roughness: 0.3 }));
    body.position.y = 0.6;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, 0.4), new THREE.MeshPhysicalMaterial({ color: "#B9C0CC", metalness: 0.6, roughness: 0.25 }));
    head.position.y = 1.15;
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.05), new THREE.MeshStandardMaterial({ color: "#5FA08C", emissive: "#5FA08C", emissiveIntensity: 1.1 }));
    eye.position.set(0, 1.15, 0.21);
    group.add(body, head, eye);
    return group;
  },

  _car(color) {
    const group = new THREE.Group();
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 0.7), new THREE.MeshPhysicalMaterial({ color, metalness: 0.6, roughness: 0.25, clearcoat: 0.5 }));
    chassis.position.y = 0.35;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.6), new THREE.MeshPhysicalMaterial({ color: "#0e1a2b", metalness: 0.3, roughness: 0.2 }));
    cabin.position.set(-0.05, 0.65, 0);
    group.add(chassis, cabin);
    [[-0.5, -0.35], [0.5, -0.35], [-0.5, 0.35], [0.5, 0.35]].forEach(([x, z]) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.15, 20), new THREE.MeshStandardMaterial({ color: "#1a1a1a", roughness: 0.7 }));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.18, z);
      group.add(wheel);
    });
    return group;
  },

  _book(color) {
    const group = new THREE.Group();
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 1.0), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    cover.position.y = 0.3;
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.08, 0.94), new THREE.MeshStandardMaterial({ color: "#F3EEE1", roughness: 0.9 }));
    pages.position.y = 0.3;
    group.add(cover, pages);
    return group;
  },

  _table(color) {
    const group = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.8), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    top.position.y = 0.7;
    group.add(top);
    [[-0.6, -0.35], [0.6, -0.35], [-0.6, 0.35], [0.6, 0.35]].forEach(([x, z]) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12), new THREE.MeshStandardMaterial({ color: "#6B4A2E", roughness: 0.8 }));
      leg.position.set(x, 0.35, z);
      group.add(leg);
    });
    return group;
  },

  _chair(color) {
    const group = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    seat.position.y = 0.45;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.08), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    back.position.set(0, 0.72, -0.21);
    group.add(seat, back);
    return group;
  },

  _icon(obj, color) {
    const group = new THREE.Group();
    group.add(TextSprite.make(obj.text || obj.label || "*", color));
    return group;
  },

  _processFlow(obj) {
    const group = new THREE.Group();
    const stageMap = {};

    (obj.stages || []).forEach((s) => {
      const pos = new THREE.Vector3(...(s.position || [0, 0, 0]));
      const node = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 0.12, 28),
        new THREE.MeshPhysicalMaterial({
          color: s.color || "#C9A24C", emissive: s.color || "#C9A24C",
          emissiveIntensity: 0.3, roughness: 0.4, metalness: 0.2,
        })
      );
      node.position.copy(pos);
      const label = TextSprite.make(s.label || s.id, "#F3EEE1");
      label.position.set(pos.x, pos.y + 0.55, pos.z);
      group.add(node, label);
      stageMap[s.id] = pos;
    });

    const pathCurves = {};
    (obj.paths || []).forEach((p) => {
      const from = stageMap[p.from], to = stageMap[p.to];
      if (!from || !to) return;
      const mid = from.clone().lerp(to, 0.5);
      mid.y += 1.15;
      const curve = new THREE.CatmullRomCurve3([from, mid, to]);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.03, 8, false),
        new THREE.MeshBasicMaterial({ color: 0xc9a24c, transparent: true, opacity: 0.35 })
      );
      group.add(tube);
      pathCurves[`${p.from}->${p.to}`] = curve;
    });

    const particles = [];
    Object.values(pathCurves).forEach((curve) => {
      for (let i = 0; i < 3; i++) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 14, 14),
          new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffcf6b, emissiveIntensity: 1.3 })
        );
        dot.visible = false;
        dot.userData.curve = curve;
        dot.userData.phase = i / 3;
        group.add(dot);
        particles.push(dot);
      }
    });

    group.userData.isProcessFlow = true;
    group.userData.flowParticles = particles;
    return group;
  },

  _makeBond(fromPos, toPos, glowColor = 0xd8d8d8) {
    const group = new THREE.Group();
    const dir = new THREE.Vector3().subVectors(toPos, fromPos);
    const length = dir.length() || 0.01;
    const mid = fromPos.clone().add(toPos).multiplyScalar(0.5);

    const bond = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, length, 14),
      MaterialLibrary.get("metal", 0xd8d8d8, { roughness: 0.35, metalness: 0.5, emissive: new THREE.Color(glowColor), emissiveIntensity: 0.12 })
    );
    bond.castShadow = true;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, length, 10),
      new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })
    );

    group.add(bond, glow);
    group.position.copy(mid);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    group.userData.isBond = true;
    return group;
  },

  _molecule(obj) {
    const group = new THREE.Group();
    const ELEMENT_STYLE = {
      H: { color: 0xf3eee1, radius: 0.22 }, O: { color: 0xc1633b, radius: 0.34 },
      C: { color: 0x4a4a4a, radius: 0.32 }, N: { color: 0x5fa08c, radius: 0.3 },
      NA: { color: 0xdab463, radius: 0.36 }, CL: { color: 0x8fbf7a, radius: 0.36 },
      FE: { color: 0xb15e3b, radius: 0.34 }, CA: { color: 0xb9c0cc, radius: 0.36 },
    };
    const mode = obj.atomStyle || "cinematic"; // "cinematic" | "electron" | "wireframe"
    const atomMap = {};

    (obj.atoms || []).forEach((a) => {
      const style = ELEMENT_STYLE[(a.element || "C").toUpperCase()] || { color: 0x8a8a8a, radius: 0.3 };
      const pos = new THREE.Vector3(...(a.position || [0, 0, 0]));

      const atomGroup = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(style.radius, 48, 48),
        mode === "wireframe"
          ? new THREE.MeshBasicMaterial({ color: style.color, wireframe: true })
          : MaterialLibrary.get("scientificAtom", style.color, { emissive: new THREE.Color(style.color), emissiveIntensity: 0.08 })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      atomGroup.add(mesh);

      // Soft atmospheric halo — cheap (one additive sprite) but reads
      // as "premium scientific visualization" rather than "flat sphere"
      const halo = makeHaloSprite(style.color, style.radius * 4.2, 0.35);
      atomGroup.add(halo);

      if (mode === "electron") {
        for (let i = 0; i < 2; i++) {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(style.radius * (1.7 + i * 0.5), 0.006, 8, 64),
            new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity: 0.35 })
          );
          ring.rotation.x = Math.PI / 2.4 * (i + 1);
          ring.rotation.y = i * 0.9;
          atomGroup.add(ring);
        }
      }

      const label = AnnotationSystem.makeCallout(a.element || "", {
        color: "#F3EEE1", accent: `#${new THREE.Color(style.color).getHexString()}`,
        scale: 0.24, offset: new THREE.Vector3(0, style.radius + 0.32, 0),
      });
      atomGroup.add(label);

      atomGroup.position.copy(pos);
      group.add(atomGroup);
      atomMap[a.id] = pos;
    });

    const bondMeshes = {};
    (obj.bonds || []).forEach((b) => {
      const from = atomMap[b.from], to = atomMap[b.to];
      if (!from || !to) return;
      const fromStyle = ELEMENT_STYLE[(b.fromElement || "").toUpperCase()];
      const glowColor = fromStyle ? fromStyle.color : 0xffe9b0;
      const bondMesh = this._makeBond(from, to, glowColor);
      group.add(bondMesh);
      bondMeshes[`${b.from}->${b.to}`] = bondMesh;
      bondMeshes[`${b.to}->${b.from}`] = bondMesh;
    });

    group.userData.isMolecule = true;
    group.userData.bondMeshes = bondMeshes;
    return group;
  },
};

/* ==============================================================
   CameraDirector — translates a shot's high-level `camera.action`
   (pushIn, orbit, wideShot, closeUp, macro, overhead, ...) into a
   smooth eased tween on the existing camera/lookAt system, instead
   of the lesson author having to hand-write raw positions for
   every beat. Falls through to explicit position/target if given.
   ============================================================== */
const CameraDirector = {
  run(engine, camCfg = {}, duration = 2) {
    const cam = engine.camera;
    const action = camCfg.action || "focus";
    const startPos = cam.position.clone();
    const startLook = engine.lookAtTarget.clone();

    const focusObj = camCfg.focus ? engine.objectsById[camCfg.focus] : null;
    const focusPos = focusObj
      ? focusObj.getWorldPosition(new THREE.Vector3())
      : (camCfg.target ? new THREE.Vector3(...camCfg.target) : startLook.clone());

    let endPos = startPos.clone();
    let endLook = focusPos.clone();

    switch (action) {
      case "pushIn": case "dollyIn": case "closeUp": case "macro": {
        const dist = action === "macro" ? 1.3 : action === "closeUp" ? 2.4 : Math.max(2.5, startPos.distanceTo(focusPos) * 0.55);
        const dir = startPos.clone().sub(focusPos);
        if (dir.lengthSq() < 0.0001) dir.set(0, 0.6, 3);
        endPos = focusPos.clone().add(dir.normalize().multiplyScalar(dist)).add(new THREE.Vector3(0, dist * 0.12, 0));
        break;
      }
      case "pullBack": case "dollyOut": case "wideShot": case "establish": {
        const dist = (action === "wideShot" || action === "establish") ? 15 : startPos.distanceTo(focusPos) * 1.7;
        const dir = startPos.clone().sub(focusPos);
        if (dir.lengthSq() < 0.0001) dir.set(0, 0.6, 3);
        endPos = focusPos.clone().add(dir.normalize().multiplyScalar(dist)).add(new THREE.Vector3(0, 2.2, 0));
        break;
      }
      case "orbit": case "arc": {
        const radius = startPos.distanceTo(focusPos) || 6;
        const sweep = THREE.MathUtils.degToRad(camCfg.angle ?? 110);
        const startAngle = Math.atan2(startPos.z - focusPos.z, startPos.x - focusPos.x);
        const endAngle = startAngle + sweep;
        endPos = new THREE.Vector3(
          focusPos.x + Math.cos(endAngle) * radius,
          startPos.y,
          focusPos.z + Math.sin(endAngle) * radius
        );
        break;
      }
      case "overhead": case "highAngle": {
        const dist = startPos.distanceTo(focusPos) || 8;
        endPos = focusPos.clone().add(new THREE.Vector3(0.001, dist * 0.95, dist * 0.3));
        break;
      }
      case "lowAngle": {
        const dist = startPos.distanceTo(focusPos) || 6;
        endPos = focusPos.clone().add(new THREE.Vector3(dist * 0.5, -0.4, dist * 0.55));
        break;
      }
      case "focus": case "rackFocus": {
        endPos = startPos.clone();
        break;
      }
      default: {
        // pan / tilt / track / follow / flyThrough — driven by explicit
        // position/target when provided, otherwise a gentle drift toward focus
        endPos = camCfg.position ? new THREE.Vector3(...camCfg.position) : startPos.clone();
      }
    }

    if (camCfg.position) endPos = new THREE.Vector3(...camCfg.position); // explicit always wins
    if (camCfg.target) endLook = new THREE.Vector3(...camCfg.target);

    engine._addTween("camera", new Tween(duration, (t) => {
      const e = Tween.easeInOutCubic(t);
      cam.position.lerpVectors(startPos, endPos, e);
      engine.lookAtTarget.lerpVectors(startLook, endLook, e);
      cam.lookAt(engine.lookAtTarget);
      if (engine.controls) engine.controls.target.copy(engine.lookAtTarget);
    }));
  },
};

/* ==============================================================
   OrbitSceneEngine — the main class
   ============================================================== */
export class OrbitSceneEngine {
  /**
   * @param {HTMLElement} container
   * @param {Object} sceneData - validated scene JSON from the backend
   * @param {Object} options - { onProgress(fractionComplete), onSubtitle(text|null), onEnd() }
   */
  constructor(container, sceneData, options = {}) {
    this.container = container;
    this.sceneData = sceneData;
    this.options = options;

    this.playbackSpeed = 1.0;
    this.voiceSpeed = 1.0;
    this.isPlaying = false;
    this.elapsed = 0;
    this.spokenIndex = 0;
    this.activeTweens = [];
    this.objectsById = {};
    this._envMeshes = [];
    this.duration = this._computeDuration();
    this.preferredVoice = null;
    this.rendererKind = null; // "webgpu" | "webgl" — set once setup finishes, useful for debugging
    this.quality = new QualityManager(sceneData.quality || null);

    this._loadPreferredVoice();

    // WebGPURenderer.init() is asynchronous (unlike the classic WebGLRenderer),
    // so the whole setup path is async now. `ready` lets callers (player.js)
    // wait for the renderer before calling play().
    this.ready = this._initRenderer().then(() => {
      this._buildScene();
      this._bindResize();
    });
  }

  // ------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------

  _computeDuration() {
    const timelineEnd = (this.sceneData.timeline || []).reduce(
      (max, e) => Math.max(max, (e.time || 0) + (e.duration || 1)), 0
    );
    const voiceEnd = (this.sceneData.voice || []).reduce(
      (max, v) => Math.max(max, (v.time || 0) + this._estimateSpeechSeconds(v.text)), 0
    );
    const shotsEnd = (this.sceneData.shots || []).reduce(
      (max, s) => Math.max(max, (s.start || 0) + (s.duration || 2)), 0
    );
    return Math.max(timelineEnd, voiceEnd, shotsEnd, 3) + 1.2;
  }

  _estimateSpeechSeconds(text) {
    const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1.4, words / 2.6); // ~155 wpm
  }

  _loadPreferredVoice() {
    if (!window.speechSynthesis) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const lang = (this.sceneData.language || "en-US").toLowerCase();
      const scored = voices.map((v) => {
        let score = 0;
        if (v.lang.toLowerCase().startsWith(lang.split("-")[0])) score += 5;
        if (/natural|neural|premium|enhanced/i.test(v.name)) score += 4;
        if (/google/i.test(v.name)) score += 2;
        if (v.localService) score += 1;
        return { v, score };
      });
      scored.sort((a, b) => b.score - a.score);
      this.preferredVoice = scored[0] ? scored[0].v : voices[0];
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
  }

  async _initRenderer() {
    this.scene = new THREE.Scene();
    // Background/fog are finalized by EnvironmentDirector in _buildScene once
    // the object list is available for theme auto-detection; a safe default
    // is set here so the very first frame isn't a flash of plain black.
    const bg = (this.sceneData.environment && this.sceneData.environment.background) || "#0e1a2b";
    this.scene.background = makeSkyTexture(lighten(bg, 0.08), bg);

    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 450;

    const camCfg = this.sceneData.camera || {};
    this.camera = new THREE.PerspectiveCamera(camCfg.fov || 45, w / h, 0.1, 200);
    const camPos = camCfg.position || [0, 3, 9];
    this.camera.position.set(camPos[0], camPos[1], camPos[2]);
    this.lookAtTarget = new THREE.Vector3(...(camCfg.lookAt || [0, 1, 0]));
    this.camera.lookAt(this.lookAtTarget);
    this.clock = new THREE.Clock();

    let webgpuSucceeded = false;
    try {
      await this._setupWebGPUPath(w, h);
      webgpuSucceeded = true;
      this.rendererKind = "webgpu";
    } catch (err) {
      console.warn("[Orbit] WebGPU render path failed, falling back to classic WebGL:", err);
    }

    if (!webgpuSucceeded) {
      this._setupWebGLFallbackPath(w, h);
      this.rendererKind = "webgl";
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.lookAtTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 40;
    // Touch: one-finger orbit, two-finger dolly/pan — keeps mobile usable
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  /** WebGPURenderer + TSL bloom post-processing. Newer, faster, but the least
   * battle-tested path in this codebase — if anything here throws (including
   * the dynamic imports themselves failing to resolve), the outer try/catch
   * in _initRenderer drops to the classic WebGL path below instead. */
  async _setupWebGPUPath(w, h) {
    const [webgpuModule, TSL] = await Promise.all([
      import("three/webgpu"),
      import("three/tsl"),
    ]);
    const WebGPU = webgpuModule; // exports WebGPURenderer, PostProcessing, etc.
    if (!WebGPU.WebGPURenderer) throw new Error("WebGPURenderer not present in this Three.js build");

    this.renderer = new WebGPU.WebGPURenderer({ antialias: true, alpha: false });
    await this.renderer.init();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.dprCap));
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.innerHTML = "";
    this.container.appendChild(this.renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // TSL node-based post-processing — the WebGPU-native replacement for
    // the classic EffectComposer/UnrealBloomPass pipeline.
    this.composer = new WebGPU.PostProcessing(this.renderer);
    const scenePass = TSL.pass(this.scene, this.camera);
    const bloomNode = TSL.bloom(scenePass, this.quality.bloomStrength, 0.5, 0.82);
    this.composer.outputNode = scenePass.add(bloomNode);
  }

  /** Classic WebGLRenderer + EffectComposer bloom — the proven, previously-
   * shipped path. Used whenever the WebGPU path isn't available or errors. */
  _setupWebGLFallbackPath(w, h) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.dprCap));
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.innerHTML = "";
    this.container.appendChild(this.renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), this.quality.bloomStrength, 0.5, 0.82);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  _bindResize() {
    this._resizeHandler = () => {
      const w = this.container.clientWidth || 800;
      const h = this.container.clientHeight || 450;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      if (this.composer.setSize) this.composer.setSize(w, h); // TSL PostProcessing auto-follows; guard for safety either way
    };
    window.addEventListener("resize", this._resizeHandler);
  }

  /** Allow the lesson player to offer a manual quality override (section 21). */
  setQuality(tier) {
    this.quality.setTier(tier);
    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.dprCap));
      this.renderer.shadowMap.enabled = this.quality.shadows;
    }
  }

  // ------------------------------------------------------------
  // Scene construction
  // ------------------------------------------------------------

  _buildScene() {
    // Contextual environment (background, fog, floor-if-any, ambient
    // particles) chosen from sceneData.environment.theme or auto-detected
    // from the objects present — replaces the old "grid floor always" default.
    EnvironmentDirector.build(this);

    // Cinematic key/fill/rim/top lighting rig
    LightingDirector.build(this);

    // Objects
    (this.sceneData.objects || []).forEach((obj) => {
      const mesh = ObjectFactory.build(obj);
      mesh.position.set(...(obj.position || [0, 1, 0]));
      mesh.rotation.set(
        THREE.MathUtils.degToRad((obj.rotation || [0, 0, 0])[0]),
        THREE.MathUtils.degToRad((obj.rotation || [0, 0, 0])[1]),
        THREE.MathUtils.degToRad((obj.rotation || [0, 0, 0])[2])
      );
      const scale = obj.scale || [1, 1, 1];
      mesh.scale.set(scale[0], scale[1], scale[2]);
      mesh.userData.orbitId = obj.id;
      mesh.userData.baseColor = obj.color || "#C9A24C";
      mesh.userData.originalScale = [...mesh.scale.toArray()];
      mesh.userData.restY = mesh.position.y;
      mesh.userData.idlePhase = hashPhase(obj.id);
      mesh.userData.isCrossSectionType = obj.type === "cross_section";
      mesh.visible = false; // objects "appear" via the timeline
      mesh.userData.everAppeared = false;
      mesh.traverse((child) => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });

      if (obj.label && obj.type !== "formula" && obj.type !== "force_vector") {
        const callout = AnnotationSystem.makeCallout(obj.label, {
          offset: new THREE.Vector3(0, (ObjectFactory.approxHeight(obj) || 1.4) + 0.5, 0),
        });
        mesh.add(callout);
      }

      this.scene.add(mesh);
      this.objectsById[obj.id] = mesh;
    });

    // Any object not targeted by an "appear" (or "revealCrossSection") timeline
    // entry should still be visible from t=0. cross_section objects default
    // hidden regardless (they're revealed via revealCrossSection, not appear).
    const appearedIds = this._managedVisibilityIds(this.sceneData.timeline || []);
    Object.entries(this.objectsById).forEach(([id, mesh]) => {
      if (!appearedIds.has(id) && !mesh.userData.isCrossSectionType) { mesh.visible = true; mesh.userData.everAppeared = true; }
    });

    this.timeline = [...(this.sceneData.timeline || [])].sort((a, b) => (a.time || 0) - (b.time || 0));
    this.voice = [...(this.sceneData.voice || [])].sort((a, b) => (a.time || 0) - (b.time || 0));
    // Cinematic shot layer (new, optional, additive — see header comment)
    this.shots = [...(this.sceneData.shots || [])].sort((a, b) => (a.start || 0) - (b.start || 0));
    this.timelinePointer = 0;
    this.shotPointer = 0;
  }

  // ------------------------------------------------------------
  // Playback controls
  // ------------------------------------------------------------

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.clock.start();
    if (window.speechSynthesis && window.speechSynthesis.paused) window.speechSynthesis.resume();
    this._loop();
  }

  pause() {
    this.isPlaying = false;
    if (window.speechSynthesis) window.speechSynthesis.pause();
  }

  _managedVisibilityIds(timeline) {
    const ids = new Set();
    (timeline || []).forEach((e) => {
      if (e.action === "appear") ids.add(e.target);
      if (e.action === "revealCrossSection") {
        const sectionId = (e.to && (e.to.section || e.to.reveal));
        if (sectionId) ids.add(sectionId);
      }
    });
    return ids;
  }

  restart() {
    this.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.elapsed = 0;
    this.spokenIndex = 0;
    this.timelinePointer = 0;
    this.shotPointer = 0;
    this.activeTweens = [];
    Object.values(this.objectsById).forEach((mesh) => {
      mesh.visible = false;
      mesh.scale.set(...mesh.userData.originalScale);
      mesh.traverse((child) => { if (child.material) { child.material.opacity = 1; child.material.transparent = false; } });
    });
    const appearedIds = this._managedVisibilityIds(this.timeline);
    Object.entries(this.objectsById).forEach(([id, mesh]) => { if (!appearedIds.has(id) && !mesh.userData.isCrossSectionType) mesh.visible = true; });
    if (this.options.onSubtitle) this.options.onSubtitle(null);
    this.play();
  }

  setSpeed(speed) { this.playbackSpeed = speed; }
  setVoiceSpeed(speed) { this.voiceSpeed = speed; }

  seekFraction(fraction) {
    // Rebuild from scratch up to the target time — simplest reliable seek
    // given tween state; acceptable since lessons are a few minutes long.
    const targetTime = fraction * this.duration;
    this.restart();
    this.pause();
    this.elapsed = 0;
    while (this.elapsed < targetTime) {
      this._advance(0.1);
      this.elapsed += 0.1;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  dispose() {
    window.removeEventListener("resize", this._resizeHandler);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.isPlaying = false;
    if (this.ambientParticles) this.ambientParticles.dispose();
    this.composer && this.composer.dispose();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------

  _loop() {
    if (!this.isPlaying) return;
    const delta = Math.min(this.clock.getDelta(), 0.1) * this.playbackSpeed;
    this.elapsed += delta;
    this._advance(delta);

    if (this.brandRing) this.brandRing.rotation.z += delta * 0.02;
    if (this.ambientParticles) this.ambientParticles.update(this.elapsed);
    if (this.controls) this.controls.update();
    this.composer.render();

    if (this.options.onProgress) this.options.onProgress(Math.min(this.elapsed / this.duration, 1));

    if (this.elapsed >= this.duration) {
      this.isPlaying = false;
      if (this.options.onEnd) this.options.onEnd();
      return;
    }
    requestAnimationFrame(() => this._loop());
  }

  _advance(delta) {
    // Fire newly-reached timeline entries
    while (this.timelinePointer < this.timeline.length &&
           this.timeline[this.timelinePointer].time <= this.elapsed) {
      this._startAnimation(this.timeline[this.timelinePointer]);
      this.timelinePointer += 1;
    }

    // Fire newly-reached cinematic shots (camera direction layer)
    while (this.shotPointer < this.shots.length &&
           (this.shots[this.shotPointer].start || 0) <= this.elapsed) {
      const shot = this.shots[this.shotPointer];
      if (shot.camera) CameraDirector.run(this, shot.camera, Math.max(0.3, shot.duration || 2));
      this.shotPointer += 1;
    }

    // Advance active tweens
    this.activeTweens = this.activeTweens.filter((tween) => !tween.step(delta));

    // Gentle idle motion for anything on screen that isn't mid-animation —
    // keeps scenes feeling alive instead of static once their beat finishes
    const busyIds = new Set(this.activeTweens.map((t) => t.targetId).filter(Boolean));
    Object.entries(this.objectsById).forEach(([id, mesh]) => {
      if (!mesh.userData.everAppeared || !mesh.visible || busyIds.has(id)) return;
      const phase = mesh.userData.idlePhase || 0;
      mesh.position.y = mesh.userData.restY + Math.sin(this.elapsed * 1.1 + phase) * 0.05;
      mesh.rotation.y += delta * 0.08;
    });

    // Idle camera drift — a slow cinematic orbit whenever no explicit
    // camera move is currently in progress, so the shot never sits dead-still
    if (!busyIds.has("camera") && this.controls) {
      const azimuth = this.controls.getAzimuthalAngle() + delta * 0.02;
      const radius = this.camera.position.distanceTo(this.controls.target);
      const polar = this.controls.getPolarAngle();
      const target = this.controls.target;
      this.camera.position.x = target.x + radius * Math.sin(polar) * Math.sin(azimuth);
      this.camera.position.z = target.z + radius * Math.sin(polar) * Math.cos(azimuth);
    }

    // Fire narration lines
    while (this.spokenIndex < this.voice.length && this.voice[this.spokenIndex].time <= this.elapsed) {
      this._speak(this.voice[this.spokenIndex]);
      this.spokenIndex += 1;
    }

    if (this.options.onSubtitle) this.options.onSubtitle(this._currentSubtitle());
  }

  _currentSubtitle() {
    const subs = this.sceneData.subtitles || this.sceneData.voice || [];
    let active = null;
    for (const line of subs) {
      const start = line.time || 0;
      const end = start + this._estimateSpeechSeconds(line.text) + 0.3;
      if (this.elapsed >= start && this.elapsed <= end) active = line.text;
    }
    return active;
  }

  _speak(line) {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(line.text);
    utter.rate = Math.min(2, Math.max(0.6, this.voiceSpeed * 0.97));
    utter.pitch = 1.0;
    utter.lang = this.sceneData.language || "en-US";
    if (this.preferredVoice) utter.voice = this.preferredVoice;
    window.speechSynthesis.speak(utter);
  }

  // ------------------------------------------------------------
  // Animation actions
  // ------------------------------------------------------------

  _addTween(targetId, tween) {
    tween.targetId = targetId === "camera" ? "camera" : targetId;
    this.activeTweens.push(tween);
  }

  _startAnimation(entry) {
    const target = entry.target === "camera" ? "camera" : this.objectsById[entry.target];
    if (!target) return;
    const duration = Math.max(0.15, entry.duration || 1);
    const to = entry.to || {};

    switch (entry.action) {
      case "appear": {
        target.visible = true;
        target.userData.everAppeared = true;
        const finalScale = target.userData.originalScale;
        target.scale.set(0.001, 0.001, 0.001);
        this._addTween(entry.target, new Tween(duration, (t) => {
          const s = Tween.easeOutBack(t);
          target.scale.set(finalScale[0] * s, finalScale[1] * s, finalScale[2] * s);
        }));
        break;
      }
      case "disappear": {
        const startScale = target.scale.toArray();
        this._addTween(entry.target, new Tween(duration, (t) => {
          const s = 1 - Tween.easeInQuad(t);
          target.scale.set(startScale[0] * s, startScale[1] * s, startScale[2] * s);
        }, () => { target.visible = false; }));
        break;
      }
      case "move": {
        const start = target.position.clone();
        const end = new THREE.Vector3(...(to.position || start.toArray()));
        this._addTween(entry.target, new Tween(duration, (t) => {
          target.position.lerpVectors(start, end, Tween.easeInOutQuad(t));
        }, () => { target.userData.restY = target.position.y; }));
        break;
      }
      case "rotate": {
        const start = target.rotation.clone();
        const endArr = (to.rotation || [0, 0, 0]).map(THREE.MathUtils.degToRad);
        this._addTween(entry.target, new Tween(duration, (t) => {
          const e = Tween.easeInOutQuad(t);
          target.rotation.set(
            start.x + (endArr[0] - start.x) * e,
            start.y + (endArr[1] - start.y) * e,
            start.z + (endArr[2] - start.z) * e
          );
        }));
        break;
      }
      case "scale": {
        const start = target.scale.toArray();
        const end = to.scale || start;
        this._addTween(entry.target, new Tween(duration, (t) => {
          const e = Tween.easeInOutQuad(t);
          target.scale.set(
            start[0] + (end[0] - start[0]) * e,
            start[1] + (end[1] - start[1]) * e,
            start[2] + (end[2] - start[2]) * e
          );
        }));
        break;
      }
      case "orbit": {
        const radius = Math.hypot(target.position.x, target.position.z) || 3;
        const startAngle = Math.atan2(target.position.z, target.position.x);
        const y = target.position.y;
        this._addTween(entry.target, new Tween(duration, (t) => {
          const angle = startAngle + t * Math.PI * 2;
          target.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        }));
        break;
      }
      case "bounce": {
        const baseY = target.position.y;
        this._addTween(entry.target, new Tween(duration, (t) => {
          target.position.y = baseY + Math.abs(Math.sin(t * Math.PI * 3)) * 0.6;
        }, () => { target.position.y = baseY; }));
        break;
      }
      case "fadeIn":
      case "fadeOut": {
        this._ensureTransparent(target);
        const from = entry.action === "fadeIn" ? 0 : 1;
        const toOpacity = entry.action === "fadeIn" ? 1 : 0;
        if (entry.action === "fadeIn") target.visible = true;
        this._addTween(entry.target, new Tween(duration, (t) => {
          this._setOpacity(target, from + (toOpacity - from) * Tween.easeInOutQuad(t));
        }));
        break;
      }
      case "highlight": {
        const original = target.userData.baseColor;
        const flashColor = new THREE.Color("#FFFFFF");
        this._addTween(entry.target, new Tween(duration, (t) => {
          const pulse = Math.sin(t * Math.PI);
          this._setColor(target, new THREE.Color(original).lerp(flashColor, pulse * 0.7));
          this._setEmissive(target, new THREE.Color(original), pulse * 0.6);
        }, () => { this._setColor(target, original); this._setEmissive(target, null, 0); }));
        break;
      }
      case "colorChange": {
        const startColor = new THREE.Color(target.userData.baseColor);
        const endColor = new THREE.Color(to.color || target.userData.baseColor);
        this._addTween(entry.target, new Tween(duration, (t) => {
          this._setColor(target, startColor.clone().lerp(endColor, Tween.easeInOutQuad(t)));
        }, () => { target.userData.baseColor = to.color || target.userData.baseColor; }));
        break;
      }
      case "cameraZoom": {
        const start = this.camera.position.clone();
        const end = new THREE.Vector3(...(to.position || start.toArray()));
        this._addTween("camera", new Tween(duration, (t) => {
          this.camera.position.lerpVectors(start, end, Tween.easeInOutQuad(t));
        }));
        break;
      }
      case "cameraPan":
      case "cameraRotate": {
        const start = this.camera.position.clone();
        const end = new THREE.Vector3(...(to.position || start.toArray()));
        const lookStart = this.lookAtTarget.clone();
        const lookEnd = new THREE.Vector3(...(to.target || lookStart.toArray()));
        this._addTween("camera", new Tween(duration, (t) => {
          const e = Tween.easeInOutQuad(t);
          this.camera.position.lerpVectors(start, end, e);
          this.lookAtTarget.lerpVectors(lookStart, lookEnd, e);
          this.camera.lookAt(this.lookAtTarget);
          if (this.controls) this.controls.target.copy(this.lookAtTarget);
        }));
        break;
      }
      case "cameraShot": {
        // New: lets a raw timeline entry (not just the shots[] layer)
        // invoke the same CameraDirector vocabulary — e.g.
        // { action: "cameraShot", to: { action: "pushIn", focus: "oxygen" } }
        CameraDirector.run(this, to, duration);
        break;
      }
      case "graphGrowth": {
        target.traverse((child) => {
          if (child.userData.isGraphBar) {
            const fullHeight = child.userData.fullHeight;
            this._addTween(entry.target, new Tween(duration, (t) => {
              const h = fullHeight * Tween.easeOutBack(t);
              child.scale.y = h / child.userData.unitHeight;
              child.position.y = h / 2;
            }));
          }
          if (child.userData.isPieSlice) {
            const mat = child.material;
            mat.transparent = true;
            this._addTween(entry.target, new Tween(duration, (t) => { mat.opacity = Tween.easeInOutQuad(t); }));
          }
        });
        break;
      }
      case "arrowFlow": {
        const baseX = target.position.x, baseY = target.position.y, baseZ = target.position.z;
        this._addTween(entry.target, new Tween(duration, (t) => {
          const pulse = Math.sin(t * Math.PI * 4) * 0.15;
          target.position.set(baseX + pulse, baseY, baseZ);
        }, () => target.position.set(baseX, baseY, baseZ)));
        break;
      }
      case "flow": {
        const particles = target.userData.flowParticles || [];
        particles.forEach((p) => { p.visible = true; });
        const travelSeconds = 2.2;
        this._addTween(entry.target, new Tween(duration, (t) => {
          const elapsed = t * duration;
          particles.forEach((p) => {
            const localT = ((elapsed / travelSeconds) + p.userData.phase) % 1;
            p.position.copy(p.userData.curve.getPointAt(localT));
          });
        }, () => { particles.forEach((p) => { p.visible = false; }); }));
        break;
      }
      case "bondForm": {
        const bondKey = to.bond ? `${to.bond.from}->${to.bond.to}` : null;
        const bondMesh = bondKey ? (target.userData.bondMeshes || {})[bondKey] : null;
        if (bondMesh) {
          bondMesh.visible = true;
          bondMesh.scale.y = 0.001;
          this._addTween(entry.target, new Tween(duration, (t) => {
            bondMesh.scale.y = Tween.easeOutBack(t);
          }));
        }
        break;
      }
      case "bondBreak": {
        const bondKey = to.bond ? `${to.bond.from}->${to.bond.to}` : null;
        const bondMesh = bondKey ? (target.userData.bondMeshes || {})[bondKey] : null;
        if (bondMesh) {
          this._addTween(entry.target, new Tween(duration, (t) => {
            bondMesh.scale.y = Math.max(0.001, 1 - Tween.easeInQuad(t));
          }, () => { bondMesh.visible = false; }));
        }
        break;
      }
      case "revealCrossSection": {
        // Ghosts the target (a beam/structural member) and reveals the
        // named cross_section object — the real "3D cutaway" the
        // engineering visualization needs instead of a flat red overlay.
        this._ensureTransparent(target);
        this._addTween(entry.target, new Tween(duration, (t) => {
          this._setOpacity(target, 1 - Tween.easeInOutQuad(t) * 0.72);
        }));
        const sectionId = to.section || to.reveal;
        const sectionObj = sectionId ? this.objectsById[sectionId] : null;
        if (sectionObj) {
          sectionObj.visible = true;
          sectionObj.userData.everAppeared = true;
          sectionObj.scale.set(0.001, 0.001, 0.001);
          const finalScale = sectionObj.userData.originalScale || [1, 1, 1];
          this._addTween(sectionId, new Tween(duration, (t) => {
            const s = Tween.easeOutBack(t);
            sectionObj.scale.set(finalScale[0] * s, finalScale[1] * s, finalScale[2] * s);
          }));
        }
        break;
      }
      case "highlightTerm": {
        // Pulses one token chip of a "formula" object in sync with narration
        // (e.g. highlight "F" while the narrator says "as force increases...").
        const chips = target.userData.tokenChips || [];
        const chip = chips.find((c) => c.userData.token === to.term);
        if (chip) {
          const base = chip.userData.baseScale || chip.scale.clone();
          this._addTween(entry.target, new Tween(duration, (t) => {
            const pulse = 1 + Math.sin(t * Math.PI) * 0.45;
            chip.scale.set(base.x * pulse, base.y * pulse, 1);
          }, () => { chip.scale.copy(base); }));
        }
        break;
      }
      case "deform": {
        // Lightweight visual bow/twist for a beam under load — not a real
        // FEA mesh deformation, but enough to read as "the structure is
        // reacting" rather than sitting perfectly rigid.
        const core = target.children.find((c) => c.userData.isBeamCore) || target;
        const startRot = core.rotation.clone();
        const startScale = core.scale.clone();
        const mode = to.mode || "bend"; // "bend" | "twist" | "stretch"
        const amount = THREE.MathUtils.degToRad(to.amount ?? 6);
        // "stretch" reads as a subtle axial elongation (normal-stress specimens
        // pulling apart) rather than a bend/twist, which fit bending/torsion.
        const stretchFactor = 1 + (to.amount ?? 2) * 0.015;
        this._addTween(entry.target, new Tween(duration, (t) => {
          const e = Math.sin(t * Math.PI); // ramps up then settles, not a hard snap
          if (mode === "twist") core.rotation.x = startRot.x + amount * e;
          else if (mode === "stretch") core.scale.x = startScale.x * (1 + (stretchFactor - 1) * e);
          else core.rotation.z = startRot.z + amount * e * 0.6;
        }, () => { if (mode === "stretch") core.scale.copy(startScale).multiplyScalar(1); }));
        break;
      }
      default:
        break;
    }
  }

  _ensureTransparent(target) {
    target.traverse((child) => { if (child.material) child.material.transparent = true; });
  }

  _setOpacity(target, value) {
    target.traverse((child) => { if (child.material) child.material.opacity = value; });
  }

  _setColor(target, color) {
    target.traverse((child) => {
      if (child.material && child.material.color) child.material.color.set(color);
    });
  }

  _setEmissive(target, color, intensity) {
    target.traverse((child) => {
      if (child.material && "emissive" in child.material) {
        if (color) child.material.emissive.set(color);
        if ("emissiveIntensity" in child.material) child.material.emissiveIntensity = intensity;
      }
    });
  }
}

window.OrbitSceneEngine = OrbitSceneEngine;