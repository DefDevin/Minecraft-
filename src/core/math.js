// Minimal, allocation-conscious math library: vectors, 4x4 matrices, AABBs, frustum.

export const DEG = Math.PI / 180;
export const EPS = 1e-6;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const fract = (x) => x - Math.floor(x);
export const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const mod = (a, n) => ((a % n) + n) % n;

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = mod(a + Math.PI, Math.PI * 2) - Math.PI;
  return a;
}

/** Shortest signed delta from angle a to angle b. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

/** Move `a` toward `b` by at most `max` radians. */
export function approachAngle(a, b, max) {
  const d = angleDelta(a, b);
  return a + clamp(d, -max, max);
}

// ---------------------------------------------------------------------------
// Vec3 — plain {x,y,z} objects. Functions take an optional output vector.
// ---------------------------------------------------------------------------

export const vec3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

export const v3set = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const v3copy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const v3add = (a, b, o = vec3()) => v3set(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const v3sub = (a, b, o = vec3()) => v3set(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const v3mul = (a, s, o = vec3()) => v3set(o, a.x * s, a.y * s, a.z * s);
export const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const v3lenSq = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const v3len = (a) => Math.sqrt(v3lenSq(a));
export const v3distSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const v3dist = (a, b) => Math.sqrt(v3distSq(a, b));

export function v3norm(a, o = vec3()) {
  const l = v3len(a);
  return l < EPS ? v3set(o, 0, 0, 0) : v3set(o, a.x / l, a.y / l, a.z / l);
}

export function v3cross(a, b, o = vec3()) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return v3set(o, x, y, z);
}

export function v3lerp(a, b, t, o = vec3()) {
  return v3set(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
}

// ---------------------------------------------------------------------------
// Mat4 — column-major Float32Array(16), matching GLSL/WebGL layout.
// ---------------------------------------------------------------------------

export function mat4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function m4identity(m) {
  m.fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function m4copy(out, a) { out.set(a); return out; }

export function m4mul(out, a, b) {
  // out = a * b
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function m4perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (far != null && far !== Infinity) {
    const nf = 1 / (near - far);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
  } else {
    out[10] = -1;
    out[14] = -2 * near;
  }
  return out;
}

export function m4ortho(out, l, r, b, t, n, f) {
  out.fill(0);
  out[0] = 2 / (r - l);
  out[5] = 2 / (t - b);
  out[10] = -2 / (f - n);
  out[12] = -(r + l) / (r - l);
  out[13] = -(t + b) / (t - b);
  out[14] = -(f + n) / (f - n);
  out[15] = 1;
  return out;
}

export function m4lookAt(out, eye, center, up) {
  let zx = eye.x - center.x, zy = eye.y - center.y, zz = eye.z - center.z;
  let l = Math.hypot(zx, zy, zz);
  if (l < EPS) { zx = 0; zy = 0; zz = 1; l = 1; }
  zx /= l; zy /= l; zz /= l;
  let xx = up.y * zz - up.z * zy;
  let xy = up.z * zx - up.x * zz;
  let xz = up.x * zy - up.y * zx;
  l = Math.hypot(xx, xy, xz);
  if (l < EPS) { xx = 1; xy = 0; xz = 0; } else { xx /= l; xy /= l; xz /= l; }
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
  out[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
  out[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
  out[15] = 1;
  return out;
}

export function m4translate(out, x, y, z) {
  m4identity(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

export function m4scale(out, x, y, z) {
  m4identity(out);
  out[0] = x; out[5] = y; out[10] = z;
  return out;
}

export function m4rotX(out, a) {
  const c = Math.cos(a), s = Math.sin(a);
  m4identity(out);
  out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
  return out;
}

export function m4rotY(out, a) {
  const c = Math.cos(a), s = Math.sin(a);
  m4identity(out);
  out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
  return out;
}

export function m4rotZ(out, a) {
  const c = Math.cos(a), s = Math.sin(a);
  m4identity(out);
  out[0] = c; out[1] = s; out[4] = -s; out[5] = c;
  return out;
}

/** Compose translation * rotY * rotX * rotZ * scale into `out`. */
export function m4compose(out, tx, ty, tz, rx, ry, rz, sx = 1, sy = 1, sz = 1) {
  const cx = Math.cos(rx), sxr = Math.sin(rx);
  const cy = Math.cos(ry), syr = Math.sin(ry);
  const cz = Math.cos(rz), szr = Math.sin(rz);
  // R = Ry * Rx * Rz
  const m00 = cy * cz + syr * sxr * szr;
  const m01 = cx * szr;
  const m02 = -syr * cz + cy * sxr * szr;
  const m10 = -cy * szr + syr * sxr * cz;
  const m11 = cx * cz;
  const m12 = syr * szr + cy * sxr * cz;
  const m20 = syr * cx;
  const m21 = -sxr;
  const m22 = cy * cx;
  out[0] = m00 * sx; out[1] = m01 * sx; out[2] = m02 * sx; out[3] = 0;
  out[4] = m10 * sy; out[5] = m11 * sy; out[6] = m12 * sy; out[7] = 0;
  out[8] = m20 * sz; out[9] = m21 * sz; out[10] = m22 * sz; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

export function m4invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function m4transformPoint(out, m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out.x = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out.y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out.z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

// ---------------------------------------------------------------------------
// Frustum culling — six planes extracted from a view-projection matrix.
// ---------------------------------------------------------------------------

export class Frustum {
  constructor() { this.planes = new Float32Array(24); }

  /** Extract planes from a column-major view-projection matrix. */
  setFromMatrix(m) {
    const p = this.planes;
    const rows = [
      [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],   // left
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],   // right
      [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],   // bottom
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],   // top
      [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],  // near
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],  // far
    ];
    for (let i = 0; i < 6; i++) {
      const r = rows[i];
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      p[i * 4] = r[0] / l;
      p[i * 4 + 1] = r[1] / l;
      p[i * 4 + 2] = r[2] / l;
      p[i * 4 + 3] = r[3] / l;
    }
    return this;
  }

  /** True if the axis-aligned box intersects or is inside the frustum. */
  intersectsBox(minX, minY, minZ, maxX, maxY, maxZ) {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const a = p[i * 4], b = p[i * 4 + 1], c = p[i * 4 + 2], d = p[i * 4 + 3];
      // Test the box corner furthest along the plane normal.
      const x = a > 0 ? maxX : minX;
      const y = b > 0 ? maxY : minY;
      const z = c > 0 ? maxZ : minZ;
      if (a * x + b * y + c * z + d < 0) return false;
    }
    return true;
  }

  intersectsSphere(x, y, z, r) {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      if (p[i * 4] * x + p[i * 4 + 1] * y + p[i * 4 + 2] * z + p[i * 4 + 3] < -r) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Axis-aligned bounding boxes
// ---------------------------------------------------------------------------

export class AABB {
  constructor(minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
  }

  static fromSize(x, y, z, w, h, d) {
    return new AABB(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2);
  }

  set(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
    return this;
  }

  copyFrom(o) {
    return this.set(o.minX, o.minY, o.minZ, o.maxX, o.maxY, o.maxZ);
  }

  clone() { return new AABB().copyFrom(this); }

  offset(x, y, z, out = new AABB()) {
    return out.set(this.minX + x, this.minY + y, this.minZ + z,
      this.maxX + x, this.maxY + y, this.maxZ + z);
  }

  expand(x, y, z, out = new AABB()) {
    out.copyFrom(this);
    if (x < 0) out.minX += x; else out.maxX += x;
    if (y < 0) out.minY += y; else out.maxY += y;
    if (z < 0) out.minZ += z; else out.maxZ += z;
    return out;
  }

  grow(x, y = x, z = x, out = new AABB()) {
    return out.set(this.minX - x, this.minY - y, this.minZ - z,
      this.maxX + x, this.maxY + y, this.maxZ + z);
  }

  intersects(o) {
    return this.minX < o.maxX && this.maxX > o.minX &&
      this.minY < o.maxY && this.maxY > o.minY &&
      this.minZ < o.maxZ && this.maxZ > o.minZ;
  }

  contains(x, y, z) {
    return x >= this.minX && x <= this.maxX &&
      y >= this.minY && y <= this.maxY &&
      z >= this.minZ && z <= this.maxZ;
  }

  get centerX() { return (this.minX + this.maxX) / 2; }
  get centerY() { return (this.minY + this.maxY) / 2; }
  get centerZ() { return (this.minZ + this.maxZ) / 2; }

  /** Clip an X-axis movement of `dx` against this box moving toward `o`. */
  clipX(o, dx) {
    if (o.maxY <= this.minY || o.minY >= this.maxY) return dx;
    if (o.maxZ <= this.minZ || o.minZ >= this.maxZ) return dx;
    if (dx > 0 && o.maxX <= this.minX) {
      const d = this.minX - o.maxX;
      if (d < dx) dx = d;
    } else if (dx < 0 && o.minX >= this.maxX) {
      const d = this.maxX - o.minX;
      if (d > dx) dx = d;
    }
    return dx;
  }

  clipY(o, dy) {
    if (o.maxX <= this.minX || o.minX >= this.maxX) return dy;
    if (o.maxZ <= this.minZ || o.minZ >= this.maxZ) return dy;
    if (dy > 0 && o.maxY <= this.minY) {
      const d = this.minY - o.maxY;
      if (d < dy) dy = d;
    } else if (dy < 0 && o.minY >= this.maxY) {
      const d = this.maxY - o.minY;
      if (d > dy) dy = d;
    }
    return dy;
  }

  clipZ(o, dz) {
    if (o.maxX <= this.minX || o.minX >= this.maxX) return dz;
    if (o.maxY <= this.minY || o.minY >= this.maxY) return dz;
    if (dz > 0 && o.maxZ <= this.minZ) {
      const d = this.minZ - o.maxZ;
      if (d < dz) dz = d;
    } else if (dz < 0 && o.minZ >= this.maxZ) {
      const d = this.maxZ - o.minZ;
      if (d > dz) dz = d;
    }
    return dz;
  }

  /**
   * Ray/box intersection. Returns {t, face} or null.
   * `face` is a direction index (0..5) matching FACES below.
   */
  rayIntersect(ox, oy, oz, dx, dy, dz, maxT) {
    let tmin = 0, tmax = maxT;
    let face = -1;
    // X slab
    for (let axis = 0; axis < 3; axis++) {
      const o = axis === 0 ? ox : axis === 1 ? oy : oz;
      const d = axis === 0 ? dx : axis === 1 ? dy : dz;
      const lo = axis === 0 ? this.minX : axis === 1 ? this.minY : this.minZ;
      const hi = axis === 0 ? this.maxX : axis === 1 ? this.maxY : this.maxZ;
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return null;
        continue;
      }
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) {
        tmin = t1;
        // The entry plane is the min plane when travelling positively, so the
        // outward normal of the hit face points the opposite way to the ray.
        // Face index: -X=0 +X=1 -Y=2 +Y=3 -Z=4 +Z=5 (see FACES).
        face = axis * 2 + (d > 0 ? 0 : 1);
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (face < 0) return null;
    return { t: tmin, face };
  }
}

// ---------------------------------------------------------------------------
// Face / direction tables. Index order is used everywhere (mesher, lighting).
// ---------------------------------------------------------------------------

/** 0:-X(west) 1:+X(east) 2:-Y(down) 3:+Y(up) 4:-Z(north) 5:+Z(south) */
export const FACES = [
  { name: 'west', dx: -1, dy: 0, dz: 0, opposite: 1 },
  { name: 'east', dx: 1, dy: 0, dz: 0, opposite: 0 },
  { name: 'down', dx: 0, dy: -1, dz: 0, opposite: 3 },
  { name: 'up', dx: 0, dy: 1, dz: 0, opposite: 2 },
  { name: 'north', dx: 0, dy: 0, dz: -1, opposite: 5 },
  { name: 'south', dx: 0, dy: 0, dz: 1, opposite: 4 },
];

export const FACE_WEST = 0, FACE_EAST = 1, FACE_DOWN = 2,
  FACE_UP = 3, FACE_NORTH = 4, FACE_SOUTH = 5;

/** Horizontal facing index (0:north 1:east 2:south 3:west) — matches MC order. */
export const HORIZONTAL = [
  { dx: 0, dz: -1, yaw: Math.PI },        // north
  { dx: 1, dz: 0, yaw: -Math.PI / 2 },    // east
  { dx: 0, dz: 1, yaw: 0 },               // south
  { dx: -1, dz: 0, yaw: Math.PI / 2 },    // west
];

/** Convert a horizontal facing index to a FACES index. */
export const HORIZ_TO_FACE = [FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST];

/** Yaw (radians) -> horizontal facing index the player is looking toward. */
export function yawToFacing(yaw) {
  return (Math.floor(yaw / (Math.PI / 2) + 0.5) & 3);
}

// ---------------------------------------------------------------------------
// Colour helpers (used by tints, fog, sky)
// ---------------------------------------------------------------------------

export function rgb(r, g, b) { return { r, g, b }; }

export function hexToRgb(hex) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

export function rgbToHex(r, g, b) {
  return (Math.round(clamp(r, 0, 1) * 255) << 16) |
    (Math.round(clamp(g, 0, 1) * 255) << 8) |
    Math.round(clamp(b, 0, 1) * 255);
}

export function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(lerp(ar, br, t)) << 16) |
    (Math.round(lerp(ag, bg, t)) << 8) |
    Math.round(lerp(ab, bb, t));
}

/** HSV (0..1) to packed RGB hex. */
export function hsv(h, s, v) {
  h = mod(h, 1) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return rgbToHex(r, g, b);
}
