// Thin WebGL2 helpers: shader compilation, buffers, VAOs, texture arrays.
// Deliberately small — the renderer owns all policy, this file owns none.

export function createContext(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: opts.antialias ?? false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    desynchronized: true,
    ...opts,
  });
  if (!gl) throw new Error('WebGL2 is required but not available in this browser');
  return gl;
}

export function compileShader(gl, type, source, name = 'shader') {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = source.split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
    gl.deleteShader(s);
    throw new Error(`${name} failed to compile:\n${log}\n${numbered}`);
  }
  return s;
}

/**
 * Link a program and cache every active uniform and attribute location, so the
 * render loop never calls getUniformLocation.
 */
export function createProgram(gl, vsSource, fsSource, name = 'program') {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, `${name} vertex`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, `${name} fragment`);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`${name} failed to link:\n${log}`);
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    // Array uniforms report as "name[0]"; store under the bare name too.
    const base = info.name.replace(/\[0\]$/, '');
    uniforms[base] = gl.getUniformLocation(p, info.name);
  }
  const attribs = {};
  const an = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < an; i++) {
    const info = gl.getActiveAttrib(p, i);
    attribs[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { program: p, uniforms, attribs, name };
}

export function createBuffer(gl, target, data, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}

/**
 * Build a 2D texture array from tightly packed RGBA layers.
 * Nearest filtering keeps the pixel-art look; mipmaps only kick in at distance,
 * where they stop distant blocks shimmering.
 */
export function createTextureArray(gl, { data, layers, size }, opts = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  const levels = Math.floor(Math.log2(size)) + 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, layers);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, layers,
    gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER,
    opts.mipmap === false ? gl.NEAREST : gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso && opts.anisotropy !== false) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(4, max));
  }
  return tex;
}

/** Upload an RGBA Sheet (mob skins, GUI atlases) as a plain 2D texture. */
export function createSheetTexture(gl, sheet, opts = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // Sheets come from several modules, so do not trust that `data` is exactly
  // width*height*4 bytes — a short buffer would otherwise throw out of the
  // typed-array constructor and take the frame down.
  const need = sheet.width * sheet.height * 4;
  let bytes;
  if (sheet.data instanceof Uint8Array && sheet.data.length === need) {
    bytes = sheet.data;
  } else {
    bytes = new Uint8Array(need);
    const src = sheet.data;
    bytes.set(src.length > need ? src.subarray(0, need) : src);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sheet.width, sheet.height, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrap || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrap || gl.CLAMP_TO_EDGE);
  return tex;
}

/** Build a small 1D-ish lookup texture from a Uint8Array of RGBA rows. */
export function createLutTexture(gl, data, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Simple GPU timing via EXT_disjoint_timer_query_webgl2 when available. */
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.query = null;
    this.pending = false;
    this.lastMs = 0;
  }
  begin() {
    if (!this.ext || this.pending) return;
    this.query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    this.active = true;
  }
  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
    this.pending = true;
  }
  poll() {
    if (!this.pending || !this.query) return this.lastMs;
    const gl = this.gl;
    if (gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE)) {
      this.lastMs = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(this.query);
      this.query = null;
      this.pending = false;
    }
    return this.lastMs;
  }
}
