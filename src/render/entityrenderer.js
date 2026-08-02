// Entity rendering: mob models, dropped items, and the first-person hand.
//
// Mob models are trees of boxes (`ModelPart`), the same structure Minecraft
// uses. Each part's geometry is baked once into a static VBO in part-local
// space; animation happens entirely through per-part matrices, so a hundred
// zombies cost a hundred small draw calls and no vertex rebuilding.

import { createSheetTexture } from './gl.js';
import { getSheet, layerOf, texturePixels } from './texgen.js';
import { mat4, m4compose, m4mul, lerp, clamp } from '../core/math.js';
import { blockOf, blocksByName } from '../world/blocks.js';

export class EntityRenderer {
  /**
   * @param {Renderer} renderer
   * @param {object|null} models  the entity/models.js module, when available
   * @param {object|null} mobTextures the render/textures/mobs.js module
   */
  constructor(renderer, models, mobTextures) {
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.models = models;
    this.mobTextures = mobTextures;
    this.skinCache = new Map();      // sheet name -> GL texture
    this.geometryCache = new Map();  // model key -> {parts: [{vao, count, part}]}
    this.modelMatrix = mat4();
    this.partMatrix = mat4();
    this.tmpMatrix = mat4();
    this.itemGeometry = new Map();   // block state -> cube VAO
    this.missingLogged = new Set();
  }

  // -- Resources -----------------------------------------------------------

  skin(name) {
    let tex = this.skinCache.get(name);
    if (tex !== undefined) return tex;
    const sheet = getSheet(name);
    if (!sheet) {
      if (!this.missingLogged.has(name)) {
        this.missingLogged.add(name);
        console.warn(`[entity] no skin sheet "${name}"`);
      }
      tex = null;
    } else {
      tex = createSheetTexture(this.gl, sheet);
    }
    this.skinCache.set(name, tex);
    return tex;
  }

  /**
   * Bake a model tree into per-part VBOs. Accepts either a `buildGeometry`
   * helper from models.js or a raw part tree, so the renderer keeps working if
   * the model module's shape shifts.
   */
  geometry(key, root, sheetWidth, sheetHeight) {
    let g = this.geometryCache.get(key);
    if (g) return g;
    const parts = [];
    const walk = (part, parentChain) => {
      const chain = parentChain.concat(part);
      const verts = [];
      for (const cube of part.cubes || []) {
        emitCube(verts, cube, sheetWidth, sheetHeight);
      }
      if (verts.length) {
        parts.push({ chain, vao: this.uploadEntityVerts(verts), count: verts.length / 8 });
      }
      for (const c of part.children || []) walk(c, chain);
    };
    if (root) walk(root, []);
    g = { parts };
    this.geometryCache.set(key, g);
    return g;
  }

  uploadEntityVerts(verts) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
    return vao;
  }

  // -- Frame ---------------------------------------------------------------

  render(world, alpha, time) {
    const gl = this.gl;
    const r = this.renderer;
    const P = r.programs.entity;
    gl.useProgram(P.program);
    gl.uniformMatrix4fv(P.uniforms.uViewProj, false, r.viewProj);
    gl.uniform3f(P.uniforms.uCameraPos, r.cameraPos.x, r.cameraPos.y, r.cameraPos.z);
    gl.uniform3fv(P.uniforms.uFogColor, hexArray(r.fogColor));
    gl.uniform1f(P.uniforms.uFogStart, r.fogStart);
    gl.uniform1f(P.uniforms.uFogEnd, r.fogEnd);
    gl.uniform1f(P.uniforms.uFogDensity, r.fogDensity);
    gl.uniform1i(P.uniforms.uSkin, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let drawn = 0;
    for (const e of world.entities) {
      if (e.removed || e.isPlayer && e.perspective === 0) continue;
      if (e.invisible) continue;
      const ex = lerp(e.prevX ?? e.x, e.x, alpha);
      const ey = lerp(e.prevY ?? e.y, e.y, alpha);
      const ez = lerp(e.prevZ ?? e.z, e.z, alpha);
      // Cull with a generous radius so tall mobs do not pop at screen edges.
      const rad = Math.max(e.width ?? 1, e.height ?? 2);
      if (!r.frustum.intersectsSphere(ex, ey + rad / 2, ez, rad * 1.6)) continue;

      if (e.renderKind === 'item' || e.itemStack) this.renderItemEntity(P, e, ex, ey, ez, time, alpha, world);
      else if (e.renderKind === 'xp_orb') this.renderXpOrb(P, e, ex, ey, ez, time, world);
      else if (e.renderKind === 'falling_block') this.renderFallingBlock(P, e, ex, ey, ez, world);
      else this.renderMob(P, e, ex, ey, ez, alpha, time, world);
      drawn++;
    }
    gl.disable(gl.BLEND);
    return drawn;
  }

  renderMob(P, e, x, y, z, alpha, time, world) {
    const modelName = e.modelName || e.type;
    const def = this.models?.getModel?.(modelName) ?? e.model;
    if (!def) return;
    const skinName = e.skin || e.textureName || modelName;
    const tex = this.skin(skinName);
    if (!tex) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);

    const sheetW = def.textureWidth ?? 64;
    const sheetH = def.textureHeight ?? 64;
    const root = def.root ?? def;
    const geo = this.geometry(`${modelName}:${sheetW}x${sheetH}`, root, sheetW, sheetH);

    // Let the model module pose the tree; if it cannot, the model renders in
    // its bind pose, which still looks correct for static mobs.
    this.models?.animate?.(def, e, alpha, time);

    const bodyYaw = lerp(e.prevBodyYaw ?? e.bodyYaw ?? 0, e.bodyYaw ?? 0, alpha);
    const scale = (e.scale ?? 1) / 16;   // model units are 1/16 of a block

    const light = this.lightAt(world, x, y + (e.height ?? 1.8) * 0.5, z);
    gl.uniform3f(P.uniforms.uLight, light[0], light[1], light[2]);
    const hurt = (e.hurtTime ?? 0) > 0 ? 0.45 : 0;
    const overlay = e.overlayColor ?? [1, 0.35, 0.35];
    gl.uniform4f(P.uniforms.uOverlay, overlay[0], overlay[1], overlay[2],
      Math.max(hurt, e.overlayStrength ?? 0));
    gl.uniform1f(P.uniforms.uAlpha, e.alpha ?? 1);
    gl.uniform1i(P.uniforms.uGlowing, e.glowing ? 1 : 0);

    for (const part of geo.parts) {
      // Compose the chain of pivots from the root down to this part.
      m4compose(this.modelMatrix, x, y, z, 0, bodyYaw, 0, scale, scale, scale);
      for (const p of part.chain) {
        m4compose(this.partMatrix,
          p.pivotX ?? 0, p.pivotY ?? 0, p.pivotZ ?? 0,
          p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0,
          p.scaleX ?? 1, p.scaleY ?? 1, p.scaleZ ?? 1);
        m4mul(this.tmpMatrix, this.modelMatrix, this.partMatrix);
        this.modelMatrix.set(this.tmpMatrix);
      }
      if (part.chain[part.chain.length - 1]?.visible === false) continue;
      this.gl.uniformMatrix4fv(P.uniforms.uModel, false, this.modelMatrix);
      this.gl.bindVertexArray(part.vao);
      this.gl.drawArrays(this.gl.TRIANGLES, 0, part.count);
      this.renderer.stats.drawCalls++;
      this.renderer.stats.triangles += part.count / 3;
    }
  }

  /** Dropped items bob and spin; block items render as a small cube. */
  renderItemEntity(P, e, x, y, z, time, alpha, world) {
    const stack = e.itemStack ?? e.stack;
    if (!stack) return;
    const bob = Math.sin((time + (e.id ?? 0) * 0.37) * 2) * 0.06;
    const spin = (time + (e.id ?? 0) * 0.7) * 1.4;
    const blockName = stack.item?.block;
    const light = this.lightAt(world, x, y + 0.2, z);
    this.gl.uniform3f(P.uniforms.uLight, light[0], light[1], light[2]);
    this.gl.uniform4f(P.uniforms.uOverlay, 0, 0, 0, 0);
    this.gl.uniform1f(P.uniforms.uAlpha, 1);
    this.gl.uniform1i(P.uniforms.uGlowing, 0);

    if (blockName) {
      this.drawBlockCube(P, blockName, x, y + 0.15 + bob, z, spin, 0.25);
    } else {
      this.drawFlatItem(P, stack, x, y + 0.15 + bob, z, spin, 0.4);
    }
  }

  renderXpOrb(P, e, x, y, z, time, world) {
    const bob = Math.sin((time + (e.id ?? 0)) * 4) * 0.04;
    this.gl.uniform3f(P.uniforms.uLight, 1.2, 1.2, 0.8);
    this.gl.uniform4f(P.uniforms.uOverlay, 0.4, 1, 0.2, 0.6);
    this.gl.uniform1f(P.uniforms.uAlpha, 1);
    this.drawFlatItem(P, null, x, y + 0.1 + bob, z,
      Math.atan2(this.renderer.cameraPos.x - x, this.renderer.cameraPos.z - z), 0.2,
      layerOf('experience_orb'));
  }

  renderFallingBlock(P, e, x, y, z, world) {
    const name = e.blockName ?? blockOf(e.blockState)?.name;
    if (!name) return;
    const light = this.lightAt(world, x, y + 0.5, z);
    this.gl.uniform3f(P.uniforms.uLight, light[0], light[1], light[2]);
    this.gl.uniform4f(P.uniforms.uOverlay, 0, 0, 0, 0);
    this.gl.uniform1f(P.uniforms.uAlpha, 1);
    this.drawBlockCube(P, name, x, y, z, 0, 1);
  }

  /** A textured unit cube pulled from the block texture array. */
  drawBlockCube(P, blockName, x, y, z, yaw, size) {
    // Block items sample the terrain atlas rather than a skin sheet, so bind it
    // as a plain 2D texture is not possible — instead reuse the entity shader
    // with a per-block sheet baked on demand.
    const tex = this.blockSheet(blockName);
    if (!tex) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (!this.cubeVao) this.buildCube();
    m4compose(this.modelMatrix, x, y, z, 0, yaw, 0, size, size, size);
    gl.uniformMatrix4fv(P.uniforms.uModel, false, this.modelMatrix);
    gl.bindVertexArray(this.cubeVao);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    this.renderer.stats.drawCalls++;
  }

  drawFlatItem(P, stack, x, y, z, yaw, size, layerOverride) {
    const tex = this.itemSheet(stack, layerOverride);
    if (!tex) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (!this.quadVaoEntity) this.buildFlatQuad();
    m4compose(this.modelMatrix, x, y, z, 0, yaw, 0, size, size, size);
    gl.uniformMatrix4fv(P.uniforms.uModel, false, this.modelMatrix);
    gl.bindVertexArray(this.quadVaoEntity);
    gl.drawArrays(gl.TRIANGLES, 0, 12);
    this.renderer.stats.drawCalls++;
  }

  /**
   * Build a 3x2 cross-layout sheet for one block so the entity shader (which
   * takes a 2D sampler) can draw block cubes without a second program.
   */
  blockSheet(blockName) {
    let tex = this.skinCache.get(`#block:${blockName}`);
    if (tex !== undefined) return tex;
    const def = blocksByNameSafe(blockName);
    if (!def) { this.skinCache.set(`#block:${blockName}`, null); return null; }
    const model = def.modelFor(def.defaultState);
    const faces = model?.[0]?.faces;
    if (!faces) { this.skinCache.set(`#block:${blockName}`, null); return null; }
    const px = 16;
    const sheet = { width: px * 6, height: px, data: new Uint8ClampedArray(px * 6 * px * 4) };
    for (let f = 0; f < 6; f++) {
      const name = faces[f]?.texture ?? faces[3]?.texture;
      if (!name) continue;
      const layer = layerOf(name);
      const src = texturePixelsSafe(layer);
      if (!src) continue;
      for (let yy = 0; yy < px; yy++) {
        for (let xx = 0; xx < px; xx++) {
          const si = (yy * px + xx) * 4;
          const di = (yy * px * 6 + f * px + xx) * 4;
          sheet.data[di] = src.data[si];
          sheet.data[di + 1] = src.data[si + 1];
          sheet.data[di + 2] = src.data[si + 2];
          sheet.data[di + 3] = src.data[si + 3];
        }
      }
    }
    tex = createSheetTexture(this.gl, sheet);
    this.skinCache.set(`#block:${blockName}`, tex);
    return tex;
  }

  itemSheet(stack, layerOverride) {
    const key = layerOverride != null
      ? `#layer:${layerOverride}`
      : `#item:${stack?.item?.texture ?? stack?.item?.name}`;
    let tex = this.skinCache.get(key);
    if (tex !== undefined) return tex;
    const layer = layerOverride != null ? layerOverride
      : layerOf(stack?.item?.texture ?? stack?.item?.name ?? 'stick');
    const src = texturePixelsSafe(layer);
    if (!src) { this.skinCache.set(key, null); return null; }
    const sheet = { width: 16, height: 16, data: src.data };
    tex = createSheetTexture(this.gl, sheet);
    this.skinCache.set(key, tex);
    return tex;
  }

  buildCube() {
    const v = [];
    // Six faces, each taking a sixth of the horizontal strip built above.
    const faces = [
      { n: [-1, 0, 0], c: [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]] },
      { n: [1, 0, 0], c: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]] },
      { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
      { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
      { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
      { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    ];
    const uv = [[0, 1], [1, 1], [1, 0], [0, 0]];
    faces.forEach((f, fi) => {
      const u0 = fi / 6, u1 = (fi + 1) / 6;
      const order = [0, 1, 2, 0, 2, 3];
      for (const k of order) {
        const c = f.c[k];
        v.push(c[0] - 0.5, c[1] - 0.5, c[2] - 0.5,
          u0 + uv[k][0] * (u1 - u0), uv[k][1], f.n[0], f.n[1], f.n[2]);
      }
    });
    this.cubeVao = this.uploadEntityVerts(v);
  }

  buildFlatQuad() {
    const v = [];
    const push = (x, y, z, u, vv, nz) => v.push(x, y, z, u, vv, 0, 0, nz);
    // Front and back so the sprite is visible from either side.
    push(-0.5, -0.5, 0, 0, 1, 1); push(0.5, -0.5, 0, 1, 1, 1); push(0.5, 0.5, 0, 1, 0, 1);
    push(-0.5, -0.5, 0, 0, 1, 1); push(0.5, 0.5, 0, 1, 0, 1); push(-0.5, 0.5, 0, 0, 0, 1);
    push(0.5, -0.5, 0, 0, 1, -1); push(-0.5, -0.5, 0, 1, 1, -1); push(-0.5, 0.5, 0, 1, 0, -1);
    push(0.5, -0.5, 0, 0, 1, -1); push(-0.5, 0.5, 0, 1, 0, -1); push(0.5, 0.5, 0, 0, 0, -1);
    this.quadVaoEntity = this.uploadEntityVerts(v);
  }

  /** Sample world light at a position and turn it into a shading colour. */
  lightAt(world, x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const sky = world.getSkyLight(bx, by, bz) / 15;
    const blk = world.getBlockLight(bx, by, bz) / 15;
    const r = this.renderer;
    const s = Math.pow(0.86, (1 - sky) * 15) * r.skyBrightness;
    const b = Math.pow(0.86, (1 - blk) * 15);
    const amb = r.ambient;
    return [
      Math.max(amb, s * 0.87 + b * 1.0),
      Math.max(amb, s * 0.91 + b * 0.81),
      Math.max(amb, s * 1.0 + b * 0.56),
    ];
  }

  // -- First person hand ---------------------------------------------------

  /**
   * Draw the held item in front of the camera. Runs with the depth buffer
   * cleared so it never intersects the world, exactly like the real game.
   */
  renderHand(player, alpha, time) {
    if (player.perspective !== 0) return;
    const gl = this.gl;
    const r = this.renderer;
    const stack = player.heldItem?.();
    const P = r.programs.entity;
    gl.useProgram(P.program);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // Swing arc: out and back over the swing progress, plus idle bob.
    const swing = player.swinging ? Math.sin(player.swingProgress * Math.PI) : 0;
    const bobT = player.walkDist * 6;
    const bobX = Math.sin(bobT) * 0.02 * Math.min(1, Math.hypot(player.vx, player.vz) * 8);
    const bobY = -Math.abs(Math.cos(bobT)) * 0.02 * Math.min(1, Math.hypot(player.vx, player.vz) * 8);

    const camDir = r.cameraDir;
    const right = normalize(cross({ x: camDir.x, y: camDir.y, z: camDir.z }, { x: 0, y: 1, z: 0 }));
    const up = normalize(cross(right, camDir));
    const isBlock = !!stack?.item?.block;
    const size = isBlock ? 0.32 : 0.36;

    const offR = 0.34 + bobX - swing * 0.12;
    const offU = -0.32 + bobY - swing * 0.18;
    const offF = 0.52 - swing * 0.2;

    const x = r.cameraPos.x + right.x * offR + up.x * offU + camDir.x * offF;
    const y = r.cameraPos.y + right.y * offR + up.y * offU + camDir.y * offF;
    const z = r.cameraPos.z + right.z * offR + up.z * offU + camDir.z * offF;

    gl.uniformMatrix4fv(P.uniforms.uViewProj, false, r.viewProj);
    gl.uniform3f(P.uniforms.uCameraPos, r.cameraPos.x, r.cameraPos.y, r.cameraPos.z);
    gl.uniform1f(P.uniforms.uFogDensity, 0);
    gl.uniform1f(P.uniforms.uFogStart, 1e6);
    gl.uniform1f(P.uniforms.uFogEnd, 1e6 + 1);
    gl.uniform1i(P.uniforms.uSkin, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const light = this.lightAt(player.world, player.x, player.eyeY, player.z);
    gl.uniform3f(P.uniforms.uLight, light[0], light[1], light[2]);
    gl.uniform4f(P.uniforms.uOverlay, 0, 0, 0, 0);
    gl.uniform1f(P.uniforms.uAlpha, 1);
    gl.uniform1i(P.uniforms.uGlowing, 0);

    const yaw = Math.atan2(camDir.x, camDir.z) + Math.PI;
    if (isBlock) {
      this.drawBlockCube(P, stack.item.block, x, y, z, yaw + 0.6, size);
    } else if (stack && !stack.empty) {
      this.drawFlatItem(P, stack, x, y, z, yaw + 0.35 - swing * 0.5, size);
    } else {
      // Empty hand: a simple arm-coloured box.
      const tex = this.armTexture();
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (!this.cubeVao) this.buildCube();
        // A forearm-shaped box angled up toward the crosshair; the long axis
        // runs away from the camera so it foreshortens instead of reading flat.
        m4compose(this.modelMatrix,
          x + camDir.x * 0.2 + right.x * 0.06,
          y - 0.16 + camDir.y * 0.2,
          z + camDir.z * 0.2 + right.z * 0.06,
          -0.5 + swing * 0.8, yaw, 0.3,
          0.055, 0.055, 0.3);
        gl.uniformMatrix4fv(P.uniforms.uModel, false, this.modelMatrix);
        gl.bindVertexArray(this.cubeVao);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
    }
    gl.disable(gl.BLEND);
  }

  armTexture() {
    let tex = this.skinCache.get('#arm');
    if (tex !== undefined) return tex;
    const sheet = { width: 96, height: 16, data: new Uint8ClampedArray(96 * 16 * 4) };
    for (let i = 0; i < 96 * 16; i++) {
      // Skin tone with a little noise so it is not a flat slab of colour.
      const n = ((i * 2654435761) >>> 24) / 255 * 0.12 - 0.06;
      sheet.data[i * 4] = clamp((0.90 + n) * 255, 0, 255);
      sheet.data[i * 4 + 1] = clamp((0.70 + n) * 255, 0, 255);
      sheet.data[i * 4 + 2] = clamp((0.56 + n) * 255, 0, 255);
      sheet.data[i * 4 + 3] = 255;
    }
    tex = createSheetTexture(this.gl, sheet);
    this.skinCache.set('#arm', tex);
    return tex;
  }
}

// ---------------------------------------------------------------------------

/**
 * Emit one model cube's 36 vertices. `cube` is {x,y,z,w,h,d,u,v,inflate?} with
 * coordinates in 1/16 block units and UVs indexing the mob's skin sheet using
 * Minecraft's box unwrap layout.
 */
function emitCube(out, cube, sheetW, sheetH) {
  const inf = cube.inflate || 0;
  const x0 = cube.x - inf, y0 = cube.y - inf, z0 = cube.z - inf;
  const x1 = cube.x + cube.w + inf, y1 = cube.y + cube.h + inf, z1 = cube.z + cube.d + inf;
  const { u, v, w, h, d } = { u: cube.u, v: cube.v, w: cube.w, h: cube.h, d: cube.d };

  // Minecraft's cube unwrap: a row of four side faces with top/bottom above.
  const faces = [
    // -X (right side of the model, drawn at u+0)
    { n: [-1, 0, 0], uv: [u, v + d, d, h],
      c: [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]] },
    // +X
    { n: [1, 0, 0], uv: [u + d + w, v + d, d, h],
      c: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]] },
    // -Y (bottom)
    { n: [0, -1, 0], uv: [u + d + w, v, w, d],
      c: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    // +Y (top)
    { n: [0, 1, 0], uv: [u + d, v, w, d],
      c: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
    // -Z (front)
    { n: [0, 0, -1], uv: [u + d, v + d, w, h],
      c: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
    // +Z (back)
    { n: [0, 0, 1], uv: [u + d + w + d, v + d, w, h],
      c: [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]] },
  ];
  const corners = [[0, 1], [1, 1], [1, 0], [0, 0]];
  for (const f of faces) {
    const [fu, fv, fw, fh] = f.uv;
    const order = [0, 1, 2, 0, 2, 3];
    for (const k of order) {
      const c = f.c[k];
      const cu = corners[k][0], cv = corners[k][1];
      out.push(c[0], c[1], c[2],
        (fu + cu * fw) / sheetW, (fv + (1 - cv) * fh) / sheetH,
        f.n[0], f.n[1], f.n[2]);
    }
  }
}

function hexArray(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

const blocksByNameSafe = (name) => blocksByName.get(name) ?? null;
const texturePixelsSafe = (layer) => texturePixels(layer) ?? null;
