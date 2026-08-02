// The renderer.
//
// Draw order per frame:
//   1. sky dome, sun/moon/stars, clouds        (depth write off)
//   2. terrain solid pass                      (opaque, front-to-back)
//   3. terrain cutout pass                     (alpha test)
//   4. entities and the held item
//   5. terrain translucent pass                (back-to-front, blended)
//   6. particles, weather, selection outline, break overlay
//   7. post-processing resolve into the canvas
//
// Everything renders into an offscreen framebuffer so the post pass can apply
// underwater tints, the nausea warp and a vignette in one go.

import {
  createContext, createProgram, createTextureArray, createSheetTexture, GpuTimer,
} from './gl.js';
import { CHUNK_VS, CHUNK_FS } from './shaders/chunk.js';
import {
  SKY_VS, SKY_FS, CELESTIAL_VS, CELESTIAL_FS, CLOUD_VS, CLOUD_FS,
  ENTITY_VS, ENTITY_FS, PARTICLE_VS, PARTICLE_FS, LINE_VS, LINE_FS,
  BREAK_VS, BREAK_FS, POST_VS, POST_FS,
} from './shaders/misc.js';
import { packLayers, layerOf, TEX_SIZE, animationInfo } from './texgen.js';
import { meshSection, FLOATS_PER_VERTEX, VERTEX_BYTES } from './mesher.js';
import {
  mat4, m4perspective, m4lookAt, m4mul, m4identity, m4compose, m4invert,
  Frustum, vec3, v3norm, clamp, lerp, hexToRgb, mixHex,
} from '../core/math.js';
import { MIN_Y, SECTION_HEIGHT, SECTION_COUNT, CHUNK_SIZE } from '../world/chunk.js';
import { PASS } from '../world/blocks.js';

/** Size in blocks of the biome colour lookup covering the area around the player. */
const BIOME_MAP_SIZE = 512;
const BIOME_MAP_LAYERS = 3;   // 0 grass, 1 foliage, 2 water

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.gl = createContext(canvas, opts);
    const gl = this.gl;

    this.width = 1; this.height = 1;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 2);
    this.renderScale = opts.renderScale ?? 1;

    this.programs = {
      chunk: createProgram(gl, CHUNK_VS, CHUNK_FS, 'chunk'),
      sky: createProgram(gl, SKY_VS, SKY_FS, 'sky'),
      celestial: createProgram(gl, CELESTIAL_VS, CELESTIAL_FS, 'celestial'),
      cloud: createProgram(gl, CLOUD_VS, CLOUD_FS, 'cloud'),
      entity: createProgram(gl, ENTITY_VS, ENTITY_FS, 'entity'),
      particle: createProgram(gl, PARTICLE_VS, PARTICLE_FS, 'particle'),
      line: createProgram(gl, LINE_VS, LINE_FS, 'line'),
      breakOverlay: createProgram(gl, BREAK_VS, BREAK_FS, 'break'),
      post: createProgram(gl, POST_VS, POST_FS, 'post'),
    };

    // Camera state
    this.proj = mat4();
    this.view = mat4();
    this.viewProj = mat4();
    this.viewNoTranslate = mat4();
    this.viewProjNoTranslate = mat4();
    this.frustum = new Frustum();
    this.fov = opts.fov ?? 70;
    this.near = 0.05;
    this.far = 512;
    this.cameraPos = vec3(0, 80, 0);
    this.cameraDir = vec3(0, 0, -1);

    // Environment
    this.skyTop = 0x78a7ff;
    this.skyHorizon = 0xc0d8ff;
    this.fogColor = 0xc0d8ff;
    this.fogStart = 0;
    this.fogEnd = 256;
    this.fogDensity = 0;
    this.skyBrightness = 1;
    this.grassColor = 0x7cbd6b;
    this.foliageColor = 0x59ae30;
    this.waterColor = 0x3f76e4;
    this.torchColor = 0xffd39a;
    this.skyLightColor = 0xdfe9ff;
    this.ambient = 0;
    this.starBrightness = 0;
    this.sunAngle = 0;
    this.moonPhase = 0;
    this.underwater = false;
    this.screenTint = [0, 0, 0, 0];
    this.vignette = 0.25;
    this.nausea = 0;
    this.hurtFlash = 0;
    this.gamma = 1.0;
    this.nightVision = 0;
    this.cloudHeight = 192;
    this.cloudsEnabled = true;
    this.renderDistance = opts.renderDistance ?? 12;

    this.stats = {
      sections: 0, drawnSections: 0, triangles: 0, drawCalls: 0,
      meshedThisFrame: 0, meshQueue: 0, gpuMs: 0,
    };

    this.meshQueue = [];
    this.meshQueued = new Set();
    this.animTick = 0;

    this.buildStaticGeometry();
    this.gpuTimer = new GpuTimer(gl);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(0.6, 0.75, 1.0, 1.0);
  }

  // -- Setup ---------------------------------------------------------------

  /** Upload the generated texture array. Call after all textures register. */
  uploadTextures() {
    const gl = this.gl;
    const packed = packLayers();
    // WebGL2 only guarantees 256 array layers; desktop GPUs give 2048+. Failing
    // here with a clear message beats a silently black world.
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.maxTextureLayers = maxLayers;
    if (packed.layers > maxLayers) {
      throw new Error(
        `${packed.layers} textures exceed this GPU's limit of ${maxLayers} array ` +
        `layers. Reduce animated texture frame counts or split the atlas.`);
    }
    this.atlas = createTextureArray(gl, packed);
    this.atlasLayers = packed.layers;
    this.animations = animationInfo();

    // Identity remap; animated ranges are rewritten each tick by
    // `updateAnimations`. R16UI keeps it exact for up to 65535 layers.
    this.layerRemap = new Uint16Array(Math.max(1, packed.layers));
    for (let i = 0; i < packed.layers; i++) this.layerRemap[i] = i;
    this.layerRemapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.layerRemapTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, this.layerRemap.length, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.uploadLayerRemap();
    return packed.layers;
  }

  uploadLayerRemap() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.layerRemapTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.layerRemap.length, 1,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.layerRemap);
  }

  /** Advance animated textures. `ticks` is the world tick counter. */
  updateAnimations(ticks) {
    if (!this.animations || this.animations.size === 0) return;
    let changed = false;
    for (const [base, info] of this.animations) {
      const frame = Math.floor(ticks / Math.max(1, info.speed)) % info.frames;
      const target = base + frame;
      if (this.layerRemap[base] !== target) { this.layerRemap[base] = target; changed = true; }
    }
    if (changed) this.uploadLayerRemap();
  }

  /** Upload one mob/GUI sheet, returning a texture handle. */
  uploadSheet(sheet) { return createSheetTexture(this.gl, sheet); }

  buildStaticGeometry() {
    const gl = this.gl;

    // Sky dome: an icosphere-ish box is enough since the shader works on
    // normalised directions.
    const s = 1;
    const cube = new Float32Array([
      -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
      -s, -s, s, s, -s, s, s, s, s, -s, s, s,
    ]);
    const cubeIdx = new Uint16Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
      1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
    ]);
    this.skyVao = this.makeVao([{ data: cube, size: 3, loc: 0 }], cubeIdx);
    this.skyIndexCount = cubeIdx.length;

    // Unit quad for celestial bodies and the post pass.
    const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
    this.quadVao = this.makeVao([{ data: quad, size: 2, loc: 0 }]);

    // Line box for the block selection outline (unit cube edges).
    const e = [];
    const c = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
      [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) e.push(...c[a], ...c[b]);
    this.lineBox = new Float32Array(e);
    this.lineVao = this.makeVao([{ data: this.lineBox, size: 3, loc: 0 }]);
    this.lineVbo = this.lastVbo;

    // Break overlay: a slightly inflated cube so the cracks sit above the block.
    const bo = [];
    const boUv = [];
    const eps = 0.002;
    const faces = [
      [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
      [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
      [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
      [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
      [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
      [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    ];
    const uvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
    for (const f of faces) {
      const order = [0, 1, 2, 0, 2, 3];
      for (const k of order) {
        const p = f[k];
        bo.push(p[0] * (1 + eps * 2) - eps, p[1] * (1 + eps * 2) - eps,
          p[2] * (1 + eps * 2) - eps);
        boUv.push(uvs[k][0], uvs[k][1]);
      }
    }
    this.breakVao = this.makeVao([
      { data: new Float32Array(bo), size: 3, loc: 0 },
      { data: new Float32Array(boUv), size: 2, loc: 1 },
    ]);

    this.buildClouds();
  }

  /** A grid of cloud boxes, scrolled by a uniform offset each frame. */
  buildClouds() {
    const gl = this.gl;
    const N = 40;           // cells per side
    const CELL = 12;        // blocks per cell
    const H = 4;            // cloud thickness
    const pos = [];
    const nor = [];
    // A deterministic blocky pattern reads much more like Minecraft than noise.
    const occupied = (i, j) => {
      let h = (i * 374761393 + j * 668265263) | 0;
      h = (h ^ (h >> 13)) * 1274126177;
      h = h ^ (h >> 16);
      return ((h >>> 0) % 100) < 34;
    };
    const push = (x0, y0, z0, x1, y1, z1, nx, ny, nz, verts) => {
      for (const v of verts) {
        pos.push(v[0] ? x1 : x0, v[1] ? y1 : y0, v[2] ? z1 : z0);
        nor.push(nx, ny, nz);
      }
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!occupied(i, j)) continue;
        const x0 = (i - N / 2) * CELL, z0 = (j - N / 2) * CELL;
        const x1 = x0 + CELL, z1 = z0 + CELL;
        const y0 = 0, y1 = H;
        // Top and bottom always; sides only where the neighbour is empty.
        push(x0, y0, z0, x1, y1, z1, 0, 1, 0, [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 1], [1, 1, 0], [0, 1, 0]]);
        push(x0, y0, z0, x1, y1, z1, 0, -1, 0, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 0], [1, 0, 1], [0, 0, 1]]);
        if (!occupied(i - 1, j)) push(x0, y0, z0, x1, y1, z1, -1, 0, 0, [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]]);
        if (!occupied(i + 1, j)) push(x0, y0, z0, x1, y1, z1, 1, 0, 0, [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0]]);
        if (!occupied(i, j - 1)) push(x0, y0, z0, x1, y1, z1, 0, 0, -1, [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]);
        if (!occupied(i, j + 1)) push(x0, y0, z0, x1, y1, z1, 0, 0, 1, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1], [1, 1, 1], [0, 1, 1]]);
      }
    }
    this.cloudVao = this.makeVao([
      { data: new Float32Array(pos), size: 3, loc: 0 },
      { data: new Float32Array(nor), size: 3, loc: 1 },
    ]);
    this.cloudVertexCount = pos.length / 3;
    this.cloudCellSize = CELL;
    this.cloudGridSpan = N * CELL;
  }

  makeVao(attribs, indices) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const a of attribs) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
      this.lastVbo = vbo;
    }
    if (indices) {
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  // -- Framebuffer ---------------------------------------------------------

  resize(width, height) {
    const gl = this.gl;
    const w = Math.max(1, Math.floor(width * this.pixelRatio * this.renderScale));
    const h = Math.max(1, Math.floor(height * this.pixelRatio * this.renderScale));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.sceneTex);
      gl.deleteRenderbuffer(this.depthRb);
    }
    this.sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // -- Camera --------------------------------------------------------------

  setCamera(x, y, z, yaw, pitch, fovOverride) {
    const aspect = this.width / this.height;
    const fov = (fovOverride ?? this.fov) * Math.PI / 180;
    this.far = Math.max(96, this.renderDistance * CHUNK_SIZE + 64);
    m4perspective(this.proj, fov, aspect, this.near, this.far);

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dy = sp;
    const dz = Math.cos(yaw) * cp;
    this.cameraPos.x = x; this.cameraPos.y = y; this.cameraPos.z = z;
    this.cameraDir.x = dx; this.cameraDir.y = dy; this.cameraDir.z = dz;

    m4lookAt(this.view, this.cameraPos,
      { x: x + dx, y: y + dy, z: z + dz }, UP);
    m4mul(this.viewProj, this.proj, this.view);
    this.frustum.setFromMatrix(this.viewProj);

    m4lookAt(this.viewNoTranslate, ORIGIN, { x: dx, y: dy, z: dz }, UP);
    m4mul(this.viewProjNoTranslate, this.proj, this.viewNoTranslate);
  }

  // -- Section meshes ------------------------------------------------------

  /** Queue a section for (re)meshing. Deduplicated. */
  queueMesh(chunk, sy, priority = 0) {
    const key = `${chunk.cx},${chunk.cz},${sy}`;
    if (this.meshQueued.has(key)) return;
    this.meshQueued.add(key);
    this.meshQueue.push({ chunk, sy, key, priority });
  }

  /** Build queued meshes within a time budget, nearest sections first. */
  processMeshQueue(world, budgetMs = 6) {
    if (this.meshQueue.length === 0) return 0;
    const t0 = performance.now();
    const px = this.cameraPos.x, py = this.cameraPos.y, pz = this.cameraPos.z;
    this.meshQueue.sort((a, b) => {
      const ad = sectionDistSq(a, px, py, pz);
      const bd = sectionDistSq(b, px, py, pz);
      return ad - bd;
    });
    let built = 0;
    while (this.meshQueue.length > 0 && performance.now() - t0 < budgetMs) {
      const job = this.meshQueue.shift();
      this.meshQueued.delete(job.key);
      const chunk = job.chunk;
      if (!world.chunks.has(chunk.key)) continue;
      const section = chunk.sections[job.sy];
      const result = section ? meshSection(world, chunk, job.sy) : null;
      this.applyMesh(chunk, job.sy, result);
      if (section) section.dirty = false;
      built++;
    }
    this.stats.meshedThisFrame = built;
    this.stats.meshQueue = this.meshQueue.length;
    return built;
  }

  applyMesh(chunk, sy, result) {
    const gl = this.gl;
    const section = chunk.sections[sy];
    if (!section) return;
    let mesh = section.mesh;
    if (!result) {
      if (mesh) { this.releaseMesh(mesh); section.mesh = null; }
      return;
    }
    if (!mesh) {
      mesh = section.mesh = { passes: [null, null, null], origin: result.origin };
    }
    mesh.origin = result.origin;
    const parts = [result.solid, result.cutout, result.translucent];
    for (let p = 0; p < 3; p++) {
      const data = parts[p];
      let slot = mesh.passes[p];
      if (!data) {
        if (slot) { this.deletePassBuffers(slot); mesh.passes[p] = null; }
        continue;
      }
      if (!slot) {
        slot = mesh.passes[p] = {
          vao: gl.createVertexArray(), vbo: gl.createBuffer(), ibo: gl.createBuffer(),
          count: 0, capacity: 0, indexCapacity: 0,
        };
        gl.bindVertexArray(slot.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, slot.vbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_BYTES, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, VERTEX_BYTES, 20);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, VERTEX_BYTES, 24);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 28);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, slot.ibo);
        gl.bindVertexArray(null);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, slot.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, slot.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
      slot.count = data.indexCount;
    }
  }

  deletePassBuffers(slot) {
    const gl = this.gl;
    gl.deleteVertexArray(slot.vao);
    gl.deleteBuffer(slot.vbo);
    gl.deleteBuffer(slot.ibo);
  }

  releaseMesh(mesh) {
    if (!mesh) return;
    for (const p of mesh.passes) if (p) this.deletePassBuffers(p);
    mesh.passes = [null, null, null];
  }

  // -- Biome colour map ----------------------------------------------------

  /**
   * A world-space lookup of grass/foliage/water colour, sampled per fragment so
   * biome transitions blend smoothly instead of snapping at chunk borders.
   */
  ensureBiomeMap() {
    if (this.biomeTex) return;
    const gl = this.gl;
    this.biomeData = new Uint8Array(BIOME_MAP_SIZE * BIOME_MAP_SIZE * 4 * BIOME_MAP_LAYERS);
    this.biomeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.biomeTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8,
      BIOME_MAP_SIZE, BIOME_MAP_SIZE, BIOME_MAP_LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.biomeOrigin = { x: -BIOME_MAP_SIZE / 2, z: -BIOME_MAP_SIZE / 2 };
    this.biomeDirty = true;
  }

  // -- Frame ---------------------------------------------------------------

  beginFrame() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(...hexArray(this.fogColor), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.drawnSections = 0;
    this.gpuTimer.begin();
  }

  renderSky(time) {
    const gl = this.gl;
    const P = this.programs.sky;
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(P.program);
    gl.uniformMatrix4fv(P.uniforms.uViewProjNoTranslate, false, this.viewProjNoTranslate);
    gl.uniform3fv(P.uniforms.uSkyTop, hexArray(this.skyTop));
    gl.uniform3fv(P.uniforms.uSkyHorizon, hexArray(this.skyHorizon));
    gl.uniform3fv(P.uniforms.uSunDir, [this.sunDir.x, this.sunDir.y, this.sunDir.z]);
    gl.uniform3fv(P.uniforms.uSunColor, hexArray(this.sunColor ?? 0xffe8b0));
    gl.uniform1f(P.uniforms.uStarBrightness, this.starBrightness);
    gl.uniform1f(P.uniforms.uTime, time);
    gl.uniform1f(P.uniforms.uRain, this.rainLevel ?? 0);
    gl.bindVertexArray(this.skyVao);
    gl.drawElements(gl.TRIANGLES, this.skyIndexCount, gl.UNSIGNED_SHORT, 0);
    this.stats.drawCalls++;

    // Sun and moon
    const C = this.programs.celestial;
    gl.useProgram(C.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(C.uniforms.uViewProjNoTranslate, false, this.viewProjNoTranslate);
    gl.bindVertexArray(this.quadVao);
    this.drawCelestial(C, this.sunDir, 0.16, this.sunColor ?? 0xfff5d0, 0, 0, 1);
    const md = { x: -this.sunDir.x, y: -this.sunDir.y, z: -this.sunDir.z };
    this.drawCelestial(C, md, 0.1, 0xdfe6f2, 1, this.moonPhase,
      clamp(-this.sunDir.y * 3, 0, 1));
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  drawCelestial(P, dir, size, color, isMoon, phase, alpha) {
    if (alpha <= 0.01) return;
    const gl = this.gl;
    // Build a basis perpendicular to the body's direction.
    const up = Math.abs(dir.y) > 0.99 ? { x: 1, y: 0, z: 0 } : UP;
    const right = v3norm({
      x: up.y * dir.z - up.z * dir.y,
      y: up.z * dir.x - up.x * dir.z,
      z: up.x * dir.y - up.y * dir.x,
    });
    const realUp = {
      x: dir.y * right.z - dir.z * right.y,
      y: dir.z * right.x - dir.x * right.z,
      z: dir.x * right.y - dir.y * right.x,
    };
    gl.uniform3f(P.uniforms.uCenter, dir.x, dir.y, dir.z);
    gl.uniform1f(P.uniforms.uSize, size);
    gl.uniform3f(P.uniforms.uRight, right.x, right.y, right.z);
    gl.uniform3f(P.uniforms.uUp, realUp.x, realUp.y, realUp.z);
    gl.uniform3fv(P.uniforms.uColor, hexArray(color));
    gl.uniform1i(P.uniforms.uIsMoon, isMoon);
    gl.uniform1i(P.uniforms.uPhase, phase);
    gl.uniform1f(P.uniforms.uAlpha, alpha);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.stats.drawCalls++;
  }

  renderClouds(time) {
    if (!this.cloudsEnabled) return;
    const gl = this.gl;
    const P = this.programs.cloud;
    gl.useProgram(P.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // Clouds drift on the X axis and follow the camera in whole cells so the
    // grid never appears to slide underfoot.
    const span = this.cloudGridSpan;
    const drift = (time * 0.6) % span;
    const cx = Math.floor(this.cameraPos.x / span) * span;
    const cz = Math.floor(this.cameraPos.z / span) * span;
    gl.uniformMatrix4fv(P.uniforms.uViewProj, false, this.viewProj);
    gl.uniform3f(P.uniforms.uOffset, cx + drift, this.cloudHeight, cz);
    gl.uniform3fv(P.uniforms.uColor, hexArray(mixHex(0xffffff, this.fogColor, 0.25)));
    gl.uniform3f(P.uniforms.uCameraPos, this.cameraPos.x, this.cameraPos.y, this.cameraPos.z);
    gl.uniform3fv(P.uniforms.uFogColor, hexArray(this.fogColor));
    gl.uniform1f(P.uniforms.uFogEnd, this.cloudGridSpan * 0.45);
    gl.uniform1f(P.uniforms.uAlpha, 0.82 * this.skyBrightness);
    gl.bindVertexArray(this.cloudVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.cloudVertexCount);
    this.stats.drawCalls++;
    // Draw a second copy so the band wraps seamlessly as it scrolls.
    gl.uniform3f(P.uniforms.uOffset, cx + drift - span, this.cloudHeight, cz);
    gl.drawArrays(gl.TRIANGLES, 0, this.cloudVertexCount);
    this.stats.drawCalls++;
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  /** Collect visible sections once, reused by all three terrain passes. */
  cullSections(world) {
    const visible = this.visibleSections || (this.visibleSections = []);
    visible.length = 0;
    const camX = this.cameraPos.x, camY = this.cameraPos.y, camZ = this.cameraPos.z;
    const maxDist = this.renderDistance * CHUNK_SIZE;
    const maxDistSq = maxDist * maxDist;
    let total = 0;
    for (const chunk of world.chunks.values()) {
      const cx = chunk.x0 + 8, cz = chunk.z0 + 8;
      const ddx = cx - camX, ddz = cz - camZ;
      if (ddx * ddx + ddz * ddz > maxDistSq + 512) continue;
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        const section = chunk.sections[sy];
        if (!section || !section.mesh) continue;
        total++;
        const oy = MIN_Y + sy * SECTION_HEIGHT;
        if (!this.frustum.intersectsBox(chunk.x0, oy, chunk.z0,
          chunk.x0 + 16, oy + 16, chunk.z0 + 16)) continue;
        const dy = oy + 8 - camY;
        visible.push({
          mesh: section.mesh,
          dist: ddx * ddx + dy * dy + ddz * ddz,
        });
      }
    }
    this.stats.sections = total;
    this.stats.drawnSections = visible.length;
    return visible;
  }

  renderTerrain(world, time) {
    const gl = this.gl;
    const P = this.programs.chunk;
    const visible = this.cullSections(world);

    gl.useProgram(P.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.uniform1i(P.uniforms.uAtlas, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.layerRemapTex);
    gl.uniform1i(P.uniforms.uLayerRemap, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniformMatrix4fv(P.uniforms.uViewProj, false, this.viewProj);
    gl.uniform3f(P.uniforms.uCameraPos, this.cameraPos.x, this.cameraPos.y, this.cameraPos.z);
    gl.uniform1f(P.uniforms.uSkyBrightness, this.skyBrightness);
    gl.uniform3fv(P.uniforms.uFogColor, hexArray(this.fogColor));
    gl.uniform1f(P.uniforms.uFogStart, this.fogStart);
    gl.uniform1f(P.uniforms.uFogEnd, this.fogEnd);
    gl.uniform1f(P.uniforms.uFogDensity, this.fogDensity);
    gl.uniform3fv(P.uniforms.uTorchColor, hexArray(this.torchColor));
    gl.uniform3fv(P.uniforms.uSkyLightColor, hexArray(this.skyLightColor));
    gl.uniform1f(P.uniforms.uAmbient, this.ambient);
    gl.uniform1i(P.uniforms.uUnderwater, this.underwater ? 1 : 0);
    gl.uniform1f(P.uniforms.uTime, time);
    gl.uniform1f(P.uniforms.uNightVision, this.nightVision);

    // Solid: front-to-back so early-z rejects the most fragments.
    visible.sort((a, b) => a.dist - b.dist);
    gl.disable(gl.BLEND);
    gl.uniform1f(P.uniforms.uAlphaCutoff, 0.0);
    this.drawPass(P, visible, PASS.SOLID);

    // Cutout: alpha-tested in the shader, still depth-writing.
    gl.uniform1f(P.uniforms.uAlphaCutoff, 0.2);
    gl.disable(gl.CULL_FACE);
    this.drawPass(P, visible, PASS.CUTOUT);
    gl.enable(gl.CULL_FACE);
    return visible;
  }

  renderTranslucent(visible) {
    const gl = this.gl;
    const P = this.programs.chunk;
    gl.useProgram(P.program);
    gl.uniform1f(P.uniforms.uAlphaCutoff, 0.0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // Back-to-front so overlapping water surfaces blend in the right order.
    visible.sort((a, b) => b.dist - a.dist);
    this.drawPass(P, visible, PASS.TRANSLUCENT);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  drawPass(P, visible, pass) {
    const gl = this.gl;
    const loc = P.uniforms.uChunkOrigin;
    for (let i = 0; i < visible.length; i++) {
      const mesh = visible[i].mesh;
      const slot = mesh.passes[pass];
      if (!slot || slot.count === 0) continue;
      gl.uniform3f(loc, mesh.origin[0], mesh.origin[1], mesh.origin[2]);
      gl.bindVertexArray(slot.vao);
      gl.drawElements(gl.TRIANGLES, slot.count, gl.UNSIGNED_INT, 0);
      this.stats.drawCalls++;
      this.stats.triangles += slot.count / 3;
    }
  }

  // -- Overlays ------------------------------------------------------------

  renderSelection(x, y, z, boxes) {
    const gl = this.gl;
    const P = this.programs.line;
    gl.useProgram(P.program);
    gl.uniformMatrix4fv(P.uniforms.uViewProj, false, this.viewProj);
    gl.uniform4f(P.uniforms.uColor, 0, 0, 0, 0.4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    for (const b of boxes) {
      // Rebuild the line box for this shape's extents.
      const v = this.lineBox;
      const src = SELECTION_EDGES;
      const eps = 0.002;
      for (let i = 0; i < src.length; i += 3) {
        v[i] = lerp(b.minX - eps, b.maxX + eps, src[i]);
        v[i + 1] = lerp(b.minY - eps, b.maxY + eps, src[i + 1]);
        v[i + 2] = lerp(b.minZ - eps, b.maxZ + eps, src[i + 2]);
      }
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, v);
      gl.uniform3f(P.uniforms.uOffset, x, y, z);
      gl.drawArrays(gl.LINES, 0, v.length / 3);
      this.stats.drawCalls++;
    }
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  renderBreakOverlay(x, y, z, stage) {
    if (stage < 0 || stage > 9) return;
    const gl = this.gl;
    const P = this.programs.breakOverlay;
    gl.useProgram(P.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.uniform1i(P.uniforms.uAtlas, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.layerRemapTex);
    gl.uniform1i(P.uniforms.uLayerRemap, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniformMatrix4fv(P.uniforms.uViewProj, false, this.viewProj);
    gl.uniform3f(P.uniforms.uOffset, x, y, z);
    gl.uniform1f(P.uniforms.uLayer, layerOf(`destroy_stage_${stage}`));
    gl.bindVertexArray(this.breakVao);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    this.stats.drawCalls++;
    gl.disable(gl.BLEND);
  }

  endFrame() {
    const gl = this.gl;
    this.gpuTimer.end();
    this.stats.gpuMs = this.gpuTimer.poll();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    const P = this.programs.post;
    gl.useProgram(P.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(P.uniforms.uScene, 0);
    gl.uniform4fv(P.uniforms.uTint, this.screenTint);
    gl.uniform1f(P.uniforms.uVignette, this.vignette);
    gl.uniform1f(P.uniforms.uNausea, this.nausea);
    gl.uniform1f(P.uniforms.uTime, performance.now() / 1000);
    gl.uniform1f(P.uniforms.uHurt, this.hurtFlash);
    gl.uniform1f(P.uniforms.uGamma, this.gamma);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}

const UP = { x: 0, y: 1, z: 0 };
const ORIGIN = { x: 0, y: 0, z: 0 };

/** Unit-cube edge endpoints in 0..1, used to rebuild selection outlines. */
const SELECTION_EDGES = (() => {
  const c = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
    [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7]];
  const out = [];
  for (const [a, b] of edges) out.push(...c[a], ...c[b]);
  return new Float32Array(out);
})();

function hexArray(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function sectionDistSq(job, px, py, pz) {
  const cx = job.chunk.x0 + 8 - px;
  const cy = MIN_Y + job.sy * SECTION_HEIGHT + 8 - py;
  const cz = job.chunk.z0 + 8 - pz;
  return cx * cx + cy * cy + cz * cz - job.priority * 1000;
}
