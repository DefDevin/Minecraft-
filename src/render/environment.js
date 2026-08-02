// Environment: derives every atmospheric parameter the renderer needs from the
// world clock, the weather, the biome under the camera, and what the camera is
// submerged in. Kept separate from the renderer so the look can be tuned without
// touching draw code.

import { clamp, lerp, mixHex, hexToRgb, smootherstep } from '../core/math.js';
import { T, blockOf } from '../world/blocks.js';
import { SEA_LEVEL } from '../world/chunk.js';

/** Sky colour at noon, at dusk, and at midnight. */
const SKY_DAY_TOP = 0x4b8fe8;
const SKY_DAY_HORIZON = 0xa8ceff;
const SKY_DUSK_TOP = 0x2a3d70;
const SKY_DUSK_HORIZON = 0xe4835a;
const SKY_NIGHT_TOP = 0x03060f;
const SKY_NIGHT_HORIZON = 0x0a1024;

const SUN_NOON = 0xfff8e0;
const SUN_DUSK = 0xff9a4d;

export class Environment {
  constructor(world) {
    this.world = world;
    this.grassColor = 0x7cbd6b;
    this.foliageColor = 0x59ae30;
    this.waterColor = 0x3f76e4;
    this.waterFogColor = 0x050533;
    this.skyTop = SKY_DAY_TOP;
    this.skyHorizon = SKY_DAY_HORIZON;
    this.fogColor = SKY_DAY_HORIZON;
    this.biomeFogColor = 0xc0d8ff;
    this.targetGrass = this.grassColor;
    this.targetFoliage = this.foliageColor;
    this.targetWater = this.waterColor;
    this.targetSky = SKY_DAY_TOP;
    this.lightningFlash = 0;
    this.biomes = null;   // injected once biomes.js is available
  }

  /** Provide the biome table so colours can follow the camera's biome. */
  setBiomeTable(biomeById) { this.biomes = biomeById; }

  /**
   * @param {Renderer} renderer
   * @param {object} camera {x,y,z,submergedIn,eyeInBlock}
   * @param {number} dt seconds
   */
  update(renderer, camera, dt) {
    const world = this.world;
    const angle = world.celestialAngle();           // 0 sunrise .. 0.5 sunset
    const rain = world.rainLevel;
    const thunder = world.thunderLevel;

    // Sun direction. `celestialAngle` is 0 at noon, 0.25 at sunset, 0.5 at
    // midnight, so elevation follows the cosine and the east-west sweep the
    // sine. A small Z tilt keeps it from passing exactly through the zenith.
    const a = angle * Math.PI * 2;
    const sunY = Math.cos(a);
    const sunX = Math.sin(a);
    const len = Math.hypot(sunX, sunY);
    renderer.sunDir = { x: sunX / len * 0.94, y: sunY / len, z: 0.34 * sunX / len };

    // Daylight factor with a fast dusk, matching Minecraft's brightness curve.
    let day = clamp(sunY * 3 + 0.35, 0, 1);
    day = smootherstep(day);
    const weatherDim = 1 - rain * 0.28 - thunder * 0.35;
    renderer.skyBrightness = clamp(day * weatherDim, 0.06, 1) *
      (world.hasSkylight ? 1 : 0);

    // Sky gradient: blend day -> dusk -> night by the sun's altitude.
    const dusk = clamp(1 - Math.abs(sunY) * 3.2, 0, 1);
    const night = clamp(-sunY * 2.5, 0, 1);
    let top = mixHex(SKY_DAY_TOP, SKY_DUSK_TOP, dusk);
    top = mixHex(top, SKY_NIGHT_TOP, night);
    let horizon = mixHex(SKY_DAY_HORIZON, SKY_DUSK_HORIZON, dusk);
    horizon = mixHex(horizon, SKY_NIGHT_HORIZON, night);

    // Biome colours follow the camera, eased so crossing a border is smooth.
    this.sampleBiome(camera);
    const ease = 1 - Math.pow(0.001, dt);
    this.grassColor = mixHex(this.grassColor, this.targetGrass, ease);
    this.foliageColor = mixHex(this.foliageColor, this.targetFoliage, ease);
    this.waterColor = mixHex(this.waterColor, this.targetWater, ease);
    this.biomeFogColor = mixHex(this.biomeFogColor, this.targetSky, ease);

    top = mixHex(top, this.biomeFogColor, 0.18);
    horizon = mixHex(horizon, this.biomeFogColor, 0.3);

    if (rain > 0) {
      const grey = 0x5a6472;
      top = mixHex(top, grey, rain * 0.65);
      horizon = mixHex(horizon, mixHex(grey, 0x8b96a4, 0.4), rain * 0.7);
    }

    // Lightning washes the whole sky out for a couple of frames.
    if (this.lightningFlash > 0) {
      this.lightningFlash = Math.max(0, this.lightningFlash - dt * 6);
      const f = this.lightningFlash;
      top = mixHex(top, 0xffffff, f * 0.8);
      horizon = mixHex(horizon, 0xffffff, f * 0.8);
      renderer.skyBrightness = Math.min(1, renderer.skyBrightness + f);
    }

    renderer.skyTop = top;
    renderer.skyHorizon = horizon;
    renderer.sunColor = mixHex(SUN_NOON, SUN_DUSK, dusk);
    renderer.starBrightness = clamp(night * 1.2 - rain, 0, 1);
    renderer.moonPhase = world.moonPhase();
    renderer.rainLevel = rain;
    renderer.grassColor = this.grassColor;
    renderer.foliageColor = this.foliageColor;
    renderer.waterColor = this.waterColor;

    // Warm torchlight, cool skylight — the contrast is what makes caves read.
    renderer.torchColor = 0xffcf8f;
    renderer.skyLightColor = mixHex(0xdfe9ff, 0xffe0c0, dusk * 0.6);
    renderer.ambient = world.ambientLight;

    this.applyDimension(renderer, world);
    this.applyFog(renderer, camera, world);
    this.applyScreenTint(renderer, camera, world);
  }

  sampleBiome(camera) {
    if (!this.biomes) return;
    const b = this.biomes[this.world.getSurfaceBiomeAt(
      Math.floor(camera.x), Math.floor(camera.z))];
    if (!b) return;
    this.targetGrass = b.grassColor ?? 0x7cbd6b;
    this.targetFoliage = b.foliageColor ?? 0x59ae30;
    this.targetWater = b.waterColor ?? 0x3f76e4;
    this.targetSky = b.fogColor ?? b.skyColor ?? 0xc0d8ff;
    this.waterFogColor = b.waterFogColor ?? 0x050533;
  }

  applyDimension(renderer, world) {
    if (world.dimension === 'nether') {
      renderer.skyTop = 0x330808;
      renderer.skyHorizon = 0x521410;
      renderer.starBrightness = 0;
      renderer.skyBrightness = 0;
      renderer.cloudsEnabled = false;
      renderer.ambient = 0.1;
    } else if (world.dimension === 'end') {
      renderer.skyTop = 0x0a0713;
      renderer.skyHorizon = 0x1b1130;
      renderer.starBrightness = 0.35;
      renderer.skyBrightness = 0;
      renderer.cloudsEnabled = false;
      renderer.ambient = 0.12;
    } else {
      renderer.cloudsEnabled = true;
    }
  }

  applyFog(renderer, camera, world) {
    const far = renderer.renderDistance * 16;
    const submerged = camera.submergedIn;

    if (submerged === 'water') {
      renderer.fogColor = this.waterFogColor;
      renderer.fogDensity = 0.12 - (camera.waterBreathing ? 0.06 : 0);
      renderer.fogStart = 0;
      renderer.fogEnd = 24;
      renderer.underwater = true;
      return;
    }
    renderer.underwater = false;
    if (submerged === 'lava') {
      renderer.fogColor = 0xd06010;
      renderer.fogDensity = camera.fireResistance ? 0.35 : 2.5;
      return;
    }
    if (submerged === 'powder_snow') {
      renderer.fogColor = 0xdfe9f5;
      renderer.fogDensity = 1.2;
      return;
    }
    renderer.fogDensity = 0;

    if (world.dimension === 'nether') {
      renderer.fogColor = 0x4a1a12;
      renderer.fogStart = far * 0.05;
      renderer.fogEnd = far * 0.55;
      return;
    }
    if (world.dimension === 'end') {
      renderer.fogColor = 0x1a1326;
      renderer.fogStart = far * 0.4;
      renderer.fogEnd = far * 1.1;
      return;
    }

    // Overworld: fog is the horizon colour so terrain dissolves into the sky.
    let fog = renderer.skyHorizon;
    // Deep underground the sky is irrelevant; fade toward black instead.
    const depth = clamp((SEA_LEVEL - 12 - camera.y) / 48, 0, 1);
    fog = mixHex(fog, 0x050508, depth * 0.9);
    renderer.fogColor = fog;
    const rainPull = world.rainLevel * 0.25;
    renderer.fogStart = far * (0.55 - rainPull);
    renderer.fogEnd = far * (0.98 - rainPull * 0.6);
  }

  applyScreenTint(renderer, camera, world) {
    const t = renderer.screenTint;
    if (camera.submergedIn === 'water') {
      const c = hexToRgb(this.waterColor);
      t[0] = c.r * 0.35; t[1] = c.g * 0.5; t[2] = c.b * 0.75; t[3] = 0.28;
    } else if (camera.submergedIn === 'lava') {
      t[0] = 0.6; t[1] = 0.2; t[2] = 0.03; t[3] = 0.75;
    } else if (camera.inPortal) {
      t[0] = 0.42; t[1] = 0.13; t[2] = 0.6; t[3] = clamp(camera.portalTime, 0, 0.7);
    } else if (camera.blindness) {
      t[0] = 0; t[1] = 0; t[2] = 0; t[3] = 0.85;
    } else {
      t[3] = Math.max(0, t[3] - 0.08);
    }
    renderer.vignette = 0.22 + (camera.lowHealth ? 0.25 : 0);
    renderer.nightVision = camera.nightVision ?? 0;
  }

  /** Called by the weather system when a bolt strikes near the camera. */
  flash() { this.lightningFlash = 1; }
}

/**
 * Minecraft's grass/foliage colour maps are indexed by temperature and
 * downfall. Reproducing the gradient procedurally keeps every biome's tint
 * consistent with its climate without shipping the colormap images.
 */
export function grassColorFor(temperature, downfall) {
  const t = clamp(temperature, 0, 1);
  const d = clamp(downfall, 0, 1) * t;
  // Dry & hot -> olive/khaki; wet & warm -> saturated green; cold -> blue-green.
  const hot = mixHex(0xbfb755, 0x59c93c, d);
  const cold = mixHex(0x80b497, 0x4c9e5a, d);
  return mixHex(cold, hot, t);
}

export function foliageColorFor(temperature, downfall) {
  const t = clamp(temperature, 0, 1);
  const d = clamp(downfall, 0, 1) * t;
  const hot = mixHex(0xaea42a, 0x30bb0b, d);
  const cold = mixHex(0x6b9e70, 0x1f8f3a, d);
  return mixHex(cold, hot, t);
}
