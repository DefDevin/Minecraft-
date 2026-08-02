// Chunk meshing.
//
// Turns a 16^3 section of block states into GPU-ready vertex data. Full opaque
// cubes go through a greedy-merge path (large flat expanses of stone or grass
// collapse into a handful of quads); everything else emits its model boxes
// directly. Ambient occlusion and per-vertex light are baked in, so the shader
// only has to sample the texture array and apply fog.
//
// Vertex layout, 28 bytes / 7 words:
//   [0..2] float  position, in blocks, relative to the section origin
//   [3..4] float  uv, in 0..1 of the texture tile (may exceed 1 when merged)
//   [5]    float  texture array layer
//   [6]    uint32 packed: normal(3) ao(2) sky(4) block(4) tint(3) emissive(4)

import { T, blockOf, RENDER, PASS, TINT } from '../world/blocks.js';
import { layerOf } from './texgen.js';
import { FACES } from '../core/math.js';
import { MIN_Y, SECTION_HEIGHT, CHUNK_SIZE } from '../world/chunk.js';

export const FLOATS_PER_VERTEX = 7;
export const VERTEX_BYTES = FLOATS_PER_VERTEX * 4;

// Packed field offsets.
const P_NORMAL = 0;    // 3 bits
const P_AO = 3;        // 2 bits
const P_SKY = 5;       // 4 bits
const P_BLOCK = 9;     // 4 bits
const P_TINT = 13;     // 3 bits
const P_EMISSIVE = 16; // 4 bits

const pack = (normal, ao, sky, block, tint, emissive) =>
  (normal << P_NORMAL) | (ao << P_AO) | (sky << P_SKY) |
  (block << P_BLOCK) | (tint << P_TINT) | (emissive << P_EMISSIVE);

// ---------------------------------------------------------------------------
// Baked models — model boxes with texture names already resolved to layers.
// Built lazily per block state and cached forever; there are only ~20k states.
// ---------------------------------------------------------------------------

const bakedCache = new Map();

function bakeModel(state) {
  let baked = bakedCache.get(state);
  if (baked !== undefined) return baked;
  const def = blockOf(state);
  if (!def) { bakedCache.set(state, null); return null; }
  const model = def.modelFor(state);
  if (!model || model.length === 0) { bakedCache.set(state, null); return null; }
  const faces = [];
  for (const bx of model) {
    for (let f = 0; f < 6; f++) {
      const fd = bx.faces[f];
      if (!fd || !fd.texture) continue;
      faces.push({
        dir: f,
        layer: layerOf(fd.texture),
        cull: fd.cull,
        tint: fd.tint || def.tint || TINT.NONE,
        emissive: fd.emissive || def.emissive || 0,
        uvRot: fd.uvRot || 0,
        // Convert model space (0..16) to block space (0..1).
        x0: bx.from[0] / 16, y0: bx.from[1] / 16, z0: bx.from[2] / 16,
        x1: bx.to[0] / 16, y1: bx.to[1] / 16, z1: bx.to[2] / 16,
        u0: fd.uv[0] / 16, v0: fd.uv[1] / 16, u1: fd.uv[2] / 16, v1: fd.uv[3] / 16,
      });
    }
  }
  baked = { faces, pass: def.pass };
  bakedCache.set(state, baked);
  return baked;
}

/** Drop the bake cache — only needed if textures are regenerated. */
export function clearBakeCache() { bakedCache.clear(); }

// ---------------------------------------------------------------------------
// Growable vertex buffers, one per render pass
// ---------------------------------------------------------------------------

class MeshBuilder {
  constructor(initial = 4096) {
    this.buffer = new ArrayBuffer(initial * VERTEX_BYTES);
    this.f32 = new Float32Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
    this.vertexCount = 0;
    this.capacity = initial;
    this.indices = new Uint32Array(initial * 6);
    this.indexCount = 0;
    this.indexCapacity = initial * 6;
  }

  reset() { this.vertexCount = 0; this.indexCount = 0; }

  ensure(extraVerts, extraIdx) {
    if (this.vertexCount + extraVerts > this.capacity) {
      let cap = this.capacity;
      while (cap < this.vertexCount + extraVerts) cap *= 2;
      const buf = new ArrayBuffer(cap * VERTEX_BYTES);
      new Uint8Array(buf).set(new Uint8Array(this.buffer, 0, this.vertexCount * VERTEX_BYTES));
      this.buffer = buf;
      this.f32 = new Float32Array(buf);
      this.u32 = new Uint32Array(buf);
      this.capacity = cap;
    }
    if (this.indexCount + extraIdx > this.indexCapacity) {
      let cap = this.indexCapacity;
      while (cap < this.indexCount + extraIdx) cap *= 2;
      const idx = new Uint32Array(cap);
      idx.set(this.indices.subarray(0, this.indexCount));
      this.indices = idx;
      this.indexCapacity = cap;
    }
  }

  vertex(x, y, z, u, v, layer, packed) {
    const i = this.vertexCount * FLOATS_PER_VERTEX;
    this.f32[i] = x; this.f32[i + 1] = y; this.f32[i + 2] = z;
    this.f32[i + 3] = u; this.f32[i + 4] = v;
    this.f32[i + 5] = layer;
    this.u32[i + 6] = packed;
    return this.vertexCount++;
  }

  /**
   * Emit a quad as two triangles. When `flip` is set the diagonal runs the other
   * way, which removes the ugly AO seam on quads with opposing dark corners.
   */
  quad(a, b, c, d, flip) {
    const idx = this.indices;
    let n = this.indexCount;
    if (flip) {
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
      idx[n++] = b; idx[n++] = d; idx[n++] = a;
    } else {
      idx[n++] = a; idx[n++] = b; idx[n++] = c;
      idx[n++] = a; idx[n++] = c; idx[n++] = d;
    }
    this.indexCount = n;
  }

  /** Copy out exactly the used range, ready for gl.bufferData. */
  extract() {
    if (this.indexCount === 0) return null;
    return {
      vertices: new Float32Array(this.buffer.slice(0, this.vertexCount * VERTEX_BYTES)),
      indices: this.indices.slice(0, this.indexCount),
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
    };
  }
}

// Reused across every section meshed on this thread.
const builders = [new MeshBuilder(), new MeshBuilder(), new MeshBuilder()];

// ---------------------------------------------------------------------------
// Neighbourhood cache
//
// A section plus its 1-block border is 18^3 = 5832 cells. Copying block states
// and light into flat arrays up front turns the inner loops into array indexing
// instead of repeated chunk-map lookups, which is worth several milliseconds.
// ---------------------------------------------------------------------------

const PAD = 1;
const NB = SECTION_HEIGHT + PAD * 2;  // 18
const NB2 = NB * NB;
const nbBlocks = new Uint16Array(NB * NB * NB);
const nbSky = new Uint8Array(NB * NB * NB);
const nbLight = new Uint8Array(NB * NB * NB);

const nbIndex = (x, y, z) => ((y + PAD) * NB2) + ((z + PAD) * NB) + (x + PAD);

function fillNeighbourhood(world, ox, oy, oz) {
  let anySolid = false;
  for (let y = -PAD; y < SECTION_HEIGHT + PAD; y++) {
    const wy = oy + y;
    for (let z = -PAD; z < SECTION_HEIGHT + PAD; z++) {
      const wz = oz + z;
      for (let x = -PAD; x < SECTION_HEIGHT + PAD; x++) {
        const i = nbIndex(x, y, z);
        const wx = ox + x;
        const st = world.getBlock(wx, wy, wz);
        nbBlocks[i] = st;
        if (st !== 0) anySolid = true;
        nbSky[i] = world.getSkyLight(wx, wy, wz);
        nbLight[i] = world.getBlockLight(wx, wy, wz);
      }
    }
  }
  return anySolid;
}

// ---------------------------------------------------------------------------
// Lighting helpers
// ---------------------------------------------------------------------------

/**
 * Minecraft's ambient-occlusion rule: a vertex is darkened by the two blocks
 * flanking it and the one diagonally across, with the flanked-on-both-sides case
 * forced to full darkness.
 */
function vertexAO(side1, side2, corner) {
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + corner);
}

/**
 * Average sky and block light over the four cells touching a vertex on the
 * outside of a face, ignoring opaque ones (which contribute nothing but would
 * drag the average to zero).
 */
function vertexLight(i0, i1, i2, i3) {
  let sky = 0, blk = 0, n = 0;
  if (!T.opaque[nbBlocks[i0]]) { sky += nbSky[i0]; blk += nbLight[i0]; n++; }
  if (!T.opaque[nbBlocks[i1]]) { sky += nbSky[i1]; blk += nbLight[i1]; n++; }
  if (!T.opaque[nbBlocks[i2]]) { sky += nbSky[i2]; blk += nbLight[i2]; n++; }
  if (!T.opaque[nbBlocks[i3]]) { sky += nbSky[i3]; blk += nbLight[i3]; n++; }
  if (n === 0) return (nbSky[i0] << 4) | nbLight[i0];
  return ((Math.round(sky / n) & 15) << 4) | (Math.round(blk / n) & 15);
}

// Per-face corner offsets. For face direction `f`, the quad's four corners in
// counter-clockwise winding when viewed from outside, expressed as unit offsets.
// Order matters: index 0..3 must match the AO neighbour tables below.
const FACE_CORNERS = [
  // west (-X): plane at x, spans z and y
  [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]],
  // east (+X)
  [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
  // down (-Y)
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  // up (+Y)
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  // north (-Z)
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  // south (+Z)
  [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
];

// For each face and corner, the two tangential offsets (side1, side2) used for
// AO and light sampling, in the plane one step outside the face.
const AO_OFFSETS = buildAOOffsets();

function buildAOOffsets() {
  const out = [];
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    // The two axes tangential to the face normal: X-normal -> (Y,Z),
    // Y-normal -> (X,Z), Z-normal -> (X,Y).
    const t1 = d.dx !== 0 ? [0, 1, 0] : [1, 0, 0];
    const t2 = d.dz !== 0 ? [0, 1, 0] : [0, 0, 1];
    const corners = [];
    for (let c = 0; c < 4; c++) {
      const corner = FACE_CORNERS[f][c];
      // Convert the 0/1 corner into -1/+1 tangential directions.
      const s1 = t1.map((v, k) => v * (corner[k] ? 1 : -1));
      const s2 = t2.map((v, k) => v * (corner[k] ? 1 : -1));
      corners.push({
        s1: [s1[0], s1[1], s1[2]],
        s2: [s2[0], s2[1], s2[2]],
        c: [s1[0] + s2[0], s1[1] + s2[1], s1[2] + s2[2]],
      });
    }
    out.push(corners);
  }
  return out;
}

/** Compute AO (0..3) and packed light for the four corners of a full-cube face. */
const cornerAO = new Uint8Array(4);
const cornerLight = new Uint8Array(4);

function computeFaceLighting(x, y, z, f) {
  const d = FACES[f];
  const ox = x + d.dx, oy = y + d.dy, oz = z + d.dz;
  const offs = AO_OFFSETS[f];
  for (let c = 0; c < 4; c++) {
    const o = offs[c];
    const i1 = nbIndex(ox + o.s1[0], oy + o.s1[1], oz + o.s1[2]);
    const i2 = nbIndex(ox + o.s2[0], oy + o.s2[1], oz + o.s2[2]);
    const ic = nbIndex(ox + o.c[0], oy + o.c[1], oz + o.c[2]);
    const ib = nbIndex(ox, oy, oz);
    const s1 = T.opaque[nbBlocks[i1]] ? 1 : 0;
    const s2 = T.opaque[nbBlocks[i2]] ? 1 : 0;
    const cr = T.opaque[nbBlocks[ic]] ? 1 : 0;
    cornerAO[c] = vertexAO(s1, s2, cr);
    cornerLight[c] = vertexLight(ib, i1, i2, ic);
  }
}

// ---------------------------------------------------------------------------
// Face visibility
// ---------------------------------------------------------------------------

function faceVisible(state, neighbor) {
  if (T.opaque[neighbor]) return false;
  if (state === neighbor && T.cullGroup[state]) return false;
  const gs = T.cullGroup[state];
  if (gs !== 0 && gs === T.cullGroup[neighbor]) return false;
  if (T.fluid[state] !== 0 && T.fluid[state] === T.fluid[neighbor]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Greedy pass for full opaque cubes
// ---------------------------------------------------------------------------

const S = SECTION_HEIGHT;
// Mask entries per slice. 0 means "no face here".
const maskState = new Uint16Array(S * S);
const maskLayer = new Int32Array(S * S);
const maskAO = new Uint32Array(S * S);     // 4 x 2 bits
const maskLight = new Uint32Array(S * S);  // 4 x 8 bits
const maskTint = new Uint8Array(S * S);
const maskEmissive = new Uint8Array(S * S);
const maskUsed = new Uint8Array(S * S);

/**
 * Greedy-mesh one face direction of the section.
 * Faces merge only when texture, tint and all four AO/light corner values are
 * identical, which guarantees the merged rectangle is genuinely uniform.
 */
function greedyPass(mb, f) {
  const d = FACES[f];
  // Axis the face normal runs along, plus the two sweep axes.
  const axis = d.dx !== 0 ? 0 : d.dy !== 0 ? 1 : 2;
  // u/v are the two axes we sweep in the slice plane.
  const uAxis = axis === 0 ? 2 : 0;
  const vAxis = axis === 1 ? 2 : 1;

  const pos = [0, 0, 0];

  for (let slice = 0; slice < S; slice++) {
    maskUsed.fill(0);
    let any = false;
    for (let v = 0; v < S; v++) {
      for (let u = 0; u < S; u++) {
        pos[axis] = slice; pos[uAxis] = u; pos[vAxis] = v;
        const x = pos[0], y = pos[1], z = pos[2];
        const i = nbIndex(x, y, z);
        const st = nbBlocks[i];
        const m = v * S + u;
        maskState[m] = 0;
        if (st === 0 || !T.fullCube[st] || T.render[st] !== RENDER.CUBE) continue;
        if (T.pass[st] !== PASS.SOLID) continue;
        const nb = nbBlocks[nbIndex(x + d.dx, y + d.dy, z + d.dz)];
        if (!faceVisible(st, nb)) continue;
        const baked = bakeModel(st);
        if (!baked) continue;
        const fd = baked.faces.find((ff) => ff.dir === f);
        if (!fd) continue;
        computeFaceLighting(x, y, z, f);
        maskState[m] = st;
        maskLayer[m] = fd.layer;
        maskAO[m] = cornerAO[0] | (cornerAO[1] << 2) | (cornerAO[2] << 4) | (cornerAO[3] << 6);
        maskLight[m] = cornerLight[0] | (cornerLight[1] << 8) |
          (cornerLight[2] << 16) | (cornerLight[3] << 24);
        maskTint[m] = fd.tint;
        maskEmissive[m] = fd.emissive;
        any = true;
      }
    }
    if (!any) continue;

    for (let v = 0; v < S; v++) {
      for (let u = 0; u < S; u++) {
        const m = v * S + u;
        if (maskState[m] === 0 || maskUsed[m]) continue;
        const layer = maskLayer[m], ao = maskAO[m], light = maskLight[m];
        const tint = maskTint[m], em = maskEmissive[m];
        // Uniform lighting is required for a merge to be correct.
        const uniform = (ao === (ao & 3) * 0x55) &&
          ((light & 255) === ((light >>> 8) & 255)) &&
          ((light & 255) === ((light >>> 16) & 255)) &&
          ((light & 255) === ((light >>> 24) & 255));
        let w = 1, h = 1;
        if (uniform) {
          while (u + w < S) {
            const mm = v * S + u + w;
            if (maskUsed[mm] || maskState[mm] === 0 || maskLayer[mm] !== layer ||
              maskAO[mm] !== ao || maskLight[mm] !== light ||
              maskTint[mm] !== tint || maskEmissive[mm] !== em) break;
            w++;
          }
          outer:
          while (v + h < S) {
            for (let k = 0; k < w; k++) {
              const mm = (v + h) * S + u + k;
              if (maskUsed[mm] || maskState[mm] === 0 || maskLayer[mm] !== layer ||
                maskAO[mm] !== ao || maskLight[mm] !== light ||
                maskTint[mm] !== tint || maskEmissive[mm] !== em) break outer;
            }
            h++;
          }
        }
        for (let dv = 0; dv < h; dv++) {
          for (let du = 0; du < w; du++) maskUsed[(v + dv) * S + u + du] = 1;
        }
        emitGreedyQuad(mb, f, axis, uAxis, vAxis, slice, u, v, w, h,
          layer, ao, light, tint, em);
      }
    }
  }
}

const qPos = [0, 0, 0];

function emitGreedyQuad(mb, f, axis, uAxis, vAxis, slice, u, v, w, h,
  layer, aoPacked, lightPacked, tint, emissive) {
  mb.ensure(4, 6);
  const corners = FACE_CORNERS[f];
  const ids = new Array(4);
  const aos = [aoPacked & 3, (aoPacked >> 2) & 3, (aoPacked >> 4) & 3, (aoPacked >> 6) & 3];
  const lights = [lightPacked & 255, (lightPacked >>> 8) & 255,
    (lightPacked >>> 16) & 255, (lightPacked >>> 24) & 255];

  for (let c = 0; c < 4; c++) {
    const corner = corners[c];
    qPos[0] = 0; qPos[1] = 0; qPos[2] = 0;
    qPos[axis] = slice + corner[axis];
    qPos[uAxis] = u + corner[uAxis] * w;
    qPos[vAxis] = v + corner[vAxis] * h;
    // Texture coordinates repeat across the merged span; the sampler wraps.
    const su = corner[uAxis] * w;
    const sv = h - corner[vAxis] * h;
    const light = lights[c];
    ids[c] = mb.vertex(qPos[0], qPos[1], qPos[2], su, sv, layer,
      pack(f, aos[c], (light >> 4) & 15, light & 15, tint, emissive));
  }
  // Flip the split when the AO gradient runs across the "wrong" diagonal.
  const flip = aos[0] + aos[2] > aos[1] + aos[3];
  mb.quad(ids[0], ids[1], ids[2], ids[3], flip);
}

// ---------------------------------------------------------------------------
// Model pass — everything that is not a full opaque cube
// ---------------------------------------------------------------------------

function modelPass(x, y, z, state) {
  const baked = bakeModel(state);
  if (!baked) return;
  const mb = builders[baked.pass];
  const renderType = T.render[state];

  if (renderType === RENDER.CROSS) {
    emitCross(mb, x, y, z, state, baked);
    return;
  }

  for (const fd of baked.faces) {
    const d = FACES[fd.dir];
    if (fd.cull) {
      const nb = nbBlocks[nbIndex(x + d.dx, y + d.dy, z + d.dz)];
      if (!faceVisible(state, nb)) continue;
    }
    computeFaceLighting(x, y, z, fd.dir);
    emitModelFace(mb, x, y, z, fd);
  }
}

const MODEL_CORNER_POS = new Float32Array(12);

function emitModelFace(mb, x, y, z, fd) {
  mb.ensure(4, 6);
  const corners = FACE_CORNERS[fd.dir];
  const ids = new Array(4);
  for (let c = 0; c < 4; c++) {
    const k = corners[c];
    const px = x + (k[0] ? fd.x1 : fd.x0);
    const py = y + (k[1] ? fd.y1 : fd.y0);
    const pz = z + (k[2] ? fd.z1 : fd.z0);
    // UV runs across the face's two tangential axes.
    const uv = faceUV(fd, k, c);
    const light = cornerLight[c];
    ids[c] = mb.vertex(px, py, pz, uv[0], uv[1], fd.layer,
      pack(fd.dir, cornerAO[c], (light >> 4) & 15, light & 15, fd.tint, fd.emissive));
  }
  const flip = cornerAO[0] + cornerAO[2] > cornerAO[1] + cornerAO[3];
  mb.quad(ids[0], ids[1], ids[2], ids[3], flip);
}

const uvTmp = [0, 0];

/** Map a face corner onto the model face's UV rectangle. */
function faceUV(fd, k, c) {
  let s, t;
  switch (fd.dir) {
    case 0: s = k[2]; t = 1 - k[1]; break;              // west: u=z, v=1-y
    case 1: s = 1 - k[2]; t = 1 - k[1]; break;          // east
    case 2: s = k[0]; t = 1 - k[2]; break;              // down
    case 3: s = k[0]; t = k[2]; break;                  // up
    case 4: s = 1 - k[0]; t = 1 - k[1]; break;          // north
    default: s = k[0]; t = 1 - k[1]; break;             // south
  }
  // Rotate UVs for blocks whose texture is authored turned (e.g. pillars).
  if (fd.uvRot) {
    for (let r = 0; r < fd.uvRot; r++) { const ns = t; t = 1 - s; s = ns; }
  }
  uvTmp[0] = fd.u0 + s * (fd.u1 - fd.u0);
  uvTmp[1] = fd.v0 + t * (fd.v1 - fd.v0);
  return uvTmp;
}

/** Two crossed quads for plants; lit uniformly from the cell they occupy. */
function emitCross(mb, x, y, z, state, baked) {
  const fd = baked.faces[0];
  if (!fd) return;
  const i = nbIndex(x, y, z);
  const above = nbIndex(x, y + 1, z);
  // Sample the brighter of this cell and the one above so plants sitting in
  // their own shadow do not go black.
  const sky = Math.max(nbSky[i], nbSky[above]);
  const blk = Math.max(nbLight[i], nbLight[above]);
  const packed = pack(3, 3, sky, blk, fd.tint, fd.emissive);
  // A small deterministic offset breaks the grid look of grass fields.
  const h = (x * 3129871 + z * 116129781 + y * 7919) | 0;
  const ox = (((h >> 4) & 15) / 15 - 0.5) * 0.35;
  const oz = (((h >> 12) & 15) / 15 - 0.5) * 0.35;
  const inset = 0.5 - Math.SQRT1_2 / 2;
  const y1 = y + (fd.y1 - fd.y0);

  for (let plane = 0; plane < 2; plane++) {
    mb.ensure(8, 12);
    const ax = plane === 0 ? inset : 1 - inset;
    const az = inset;
    const bx = plane === 0 ? 1 - inset : inset;
    const bz = 1 - inset;
    const x0 = x + ax + ox, z0 = z + az + oz;
    const x1 = x + bx + ox, z1 = z + bz + oz;
    const a = mb.vertex(x0, y + fd.y0, z0, fd.u0, fd.v1, fd.layer, packed);
    const b = mb.vertex(x1, y + fd.y0, z1, fd.u1, fd.v1, fd.layer, packed);
    const c = mb.vertex(x1, y1, z1, fd.u1, fd.v0, fd.layer, packed);
    const dd = mb.vertex(x0, y1, z0, fd.u0, fd.v0, fd.layer, packed);
    mb.quad(a, b, c, dd, false);
    // Back face, so plants are visible from both sides.
    const a2 = mb.vertex(x1, y + fd.y0, z1, fd.u0, fd.v1, fd.layer, packed);
    const b2 = mb.vertex(x0, y + fd.y0, z0, fd.u1, fd.v1, fd.layer, packed);
    const c2 = mb.vertex(x0, y1, z0, fd.u1, fd.v0, fd.layer, packed);
    const d2 = mb.vertex(x1, y1, z1, fd.u0, fd.v0, fd.layer, packed);
    mb.quad(a2, b2, c2, d2, false);
  }
}

// ---------------------------------------------------------------------------
// Fluids — surface height comes from the neighbouring fluid levels so water
// slopes smoothly toward its flow direction.
// ---------------------------------------------------------------------------

function fluidCornerHeight(x, y, z, fluid) {
  // Average the height of the four cells touching this corner.
  let total = 0, count = 0;
  for (let dz = -1; dz <= 0; dz++) {
    for (let dx = -1; dx <= 0; dx++) {
      const above = nbBlocks[nbIndex(x + dx, y + 1, z + dz)];
      if (T.fluid[above] === fluid) return 1;
      const st = nbBlocks[nbIndex(x + dx, y, z + dz)];
      if (T.fluid[st] === fluid) {
        const lvl = T.fluidLevel[st];
        total += lvl === 0 ? 1 : (8 - lvl) / 8;
        count++;
      } else if (!T.solid[st]) {
        count++;   // air pulls the corner down, producing the shoreline slope
      }
    }
  }
  if (count === 0) return 0.9;
  return Math.min(1, total / count * 1.05);
}

function fluidPass(x, y, z, state) {
  const fluid = T.fluid[state];
  const mb = builders[fluid === 1 ? PASS.TRANSLUCENT : PASS.SOLID];
  const baked = bakeModel(state);
  if (!baked) return;
  const topFace = baked.faces.find((f) => f.dir === 3) || baked.faces[0];
  const sideFace = baked.faces.find((f) => f.dir === 5) || topFace;
  const tint = fluid === 1 ? TINT.WATER : TINT.NONE;
  const emissive = fluid === 2 ? 15 : 0;

  const above = nbBlocks[nbIndex(x, y + 1, z)];
  const sameAbove = T.fluid[above] === fluid;
  // Corner heights, in the order used by FACE_CORNERS for the up face.
  const h00 = sameAbove ? 1 : fluidCornerHeight(x, y, z, fluid);
  const h10 = sameAbove ? 1 : fluidCornerHeight(x + 1, y, z, fluid);
  const h11 = sameAbove ? 1 : fluidCornerHeight(x + 1, y, z + 1, fluid);
  const h01 = sameAbove ? 1 : fluidCornerHeight(x, y, z + 1, fluid);

  const i = nbIndex(x, y, z);
  const sky = nbSky[i], blk = nbLight[i];
  const packed = pack(3, 3, sky, blk, tint, emissive);

  // Top surface
  if (!sameAbove && faceVisible(state, above)) {
    mb.ensure(4, 6);
    const a = mb.vertex(x, y + h01, z + 1, 0, 1, topFace.layer, packed);
    const b = mb.vertex(x + 1, y + h11, z + 1, 1, 1, topFace.layer, packed);
    const c = mb.vertex(x + 1, y + h10, z, 1, 0, topFace.layer, packed);
    const d = mb.vertex(x, y + h00, z, 0, 0, topFace.layer, packed);
    mb.quad(a, b, c, d, false);
    // Underside, so the surface is visible from below the waterline.
    const a2 = mb.vertex(x, y + h00, z, 0, 0, topFace.layer, packed);
    const b2 = mb.vertex(x + 1, y + h10, z, 1, 0, topFace.layer, packed);
    const c2 = mb.vertex(x + 1, y + h11, z + 1, 1, 1, topFace.layer, packed);
    const d2 = mb.vertex(x, y + h01, z + 1, 0, 1, topFace.layer, packed);
    mb.quad(a2, b2, c2, d2, false);
  }

  // Bottom
  const below = nbBlocks[nbIndex(x, y - 1, z)];
  if (faceVisible(state, below)) {
    mb.ensure(4, 6);
    const p = pack(2, 3, nbSky[nbIndex(x, y - 1, z)], nbLight[nbIndex(x, y - 1, z)], tint, emissive);
    const a = mb.vertex(x, y, z, 0, 0, topFace.layer, p);
    const b = mb.vertex(x + 1, y, z, 1, 0, topFace.layer, p);
    const c = mb.vertex(x + 1, y, z + 1, 1, 1, topFace.layer, p);
    const d = mb.vertex(x, y, z + 1, 0, 1, topFace.layer, p);
    mb.quad(a, b, c, d, false);
  }

  // Sides. A top vertex takes the height of the (x,z) corner it sits on, so
  // adjacent fluid cells agree along their shared edge and the surface is
  // continuous rather than stepped.
  const cornerH = (kx, kz) => (kx === 0 ? (kz === 0 ? h00 : h01) : (kz === 0 ? h10 : h11));
  for (const f of [0, 1, 4, 5]) {
    const d = FACES[f];
    const nb = nbBlocks[nbIndex(x + d.dx, y + d.dy, z + d.dz)];
    if (!faceVisible(state, nb)) continue;
    if (T.opaque[nb]) continue;
    mb.ensure(4, 6);
    const ni = nbIndex(x + d.dx, y, z + d.dz);
    const p = pack(f, 3, nbSky[ni], nbLight[ni], tint, emissive);
    const corners = FACE_CORNERS[f];
    const ids = new Array(4);
    for (let c = 0; c < 4; c++) {
      const k = corners[c];
      const hh = k[1] === 1 ? cornerH(k[0], k[2]) : 0;
      const uv = faceUV(sideFace, k, c);
      // V follows the sloped top edge so the texture is not stretched.
      const v = k[1] === 1
        ? sideFace.v0 + (1 - hh) * (sideFace.v1 - sideFace.v0)
        : sideFace.v1;
      ids[c] = mb.vertex(x + k[0], y + hh, z + k[2], uv[0], v, sideFace.layer, p);
    }
    mb.quad(ids[0], ids[1], ids[2], ids[3], false);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Mesh one section.
 * @returns {{solid, cutout, translucent}|null} extracted buffers, or null when empty
 */
export function meshSection(world, chunk, sy) {
  const section = chunk.sections[sy];
  const ox = chunk.x0, oy = MIN_Y + sy * SECTION_HEIGHT, oz = chunk.z0;
  if (!section || section.empty) {
    // Even an empty section can need faces if a neighbour is not empty — but
    // those faces belong to the neighbour, so nothing to do.
    return null;
  }

  fillNeighbourhood(world, ox, oy, oz);
  for (const b of builders) b.reset();

  // Greedy pass covers full opaque cubes.
  for (let f = 0; f < 6; f++) greedyPass(builders[PASS.SOLID], f);

  // Everything else, cell by cell.
  for (let y = 0; y < S; y++) {
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const st = nbBlocks[nbIndex(x, y, z)];
        if (st === 0) continue;
        const r = T.render[st];
        if (r === RENDER.INVISIBLE) continue;
        if (r === RENDER.FLUID) { fluidPass(x, y, z, st); continue; }
        // Full opaque cubes were handled by the greedy pass.
        if (r === RENDER.CUBE && T.fullCube[st] && T.pass[st] === PASS.SOLID) continue;
        modelPass(x, y, z, st);
      }
    }
  }

  const solid = builders[PASS.SOLID].extract();
  const cutout = builders[PASS.CUTOUT].extract();
  const translucent = builders[PASS.TRANSLUCENT].extract();
  if (!solid && !cutout && !translucent) return null;
  return { solid, cutout, translucent, origin: [ox, oy, oz] };
}

/** Total triangles the last mesh produced — used by the debug overlay. */
export function lastMeshStats() {
  return {
    solid: builders[0].indexCount / 3,
    cutout: builders[1].indexCount / 3,
    translucent: builders[2].indexCount / 3,
  };
}
