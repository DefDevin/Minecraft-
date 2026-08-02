// Sky, celestial bodies, clouds, entities, particles, selection outline and the
// post-processing pass.

/** Fullscreen-ish sky dome, drawn first with depth writes off. */
export const SKY_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProjNoTranslate;
out vec3 vDir;
void main() {
  vDir = aPos;
  vec4 p = uViewProjNoTranslate * vec4(aPos, 1.0);
  // Force the dome to the far plane so nothing can z-fight with it.
  gl_Position = p.xyww;
}
`;

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vDir;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uStarBrightness;
uniform float uTime;
uniform float uRain;
out vec4 fragColor;

// Cheap stable hash for the star field.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);

  // Two-stop gradient with a tighter falloff near the horizon.
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(h, 0.65));

  // Warm scattering around the sun, strongest at sunrise and sunset.
  float sunDot = max(dot(d, uSunDir), 0.0);
  float horizonGlow = pow(1.0 - abs(uSunDir.y), 3.0);
  sky += uSunColor * pow(sunDot, 6.0) * 0.35;
  sky += uSunColor * pow(sunDot, 1.5) * horizonGlow * 0.5;

  // Stars: a sparse threshold over a hashed direction grid, faded by daylight.
  if (uStarBrightness > 0.001 && d.y > -0.1) {
    vec3 cell = floor(d * 220.0);
    float r = hash13(cell);
    if (r > 0.9965) {
      float twinkle = 0.65 + 0.35 * sin(uTime * 2.5 + r * 100.0);
      float fade = clamp(d.y * 4.0, 0.0, 1.0);
      sky += vec3(0.95, 0.96, 1.0) * uStarBrightness * twinkle * fade;
    }
  }

  sky = mix(sky, vec3(0.42, 0.44, 0.47) * (0.3 + 0.7 * h), uRain * 0.8);
  fragColor = vec4(sky, 1.0);
}
`;

/** Sun and moon quads. */
export const CELESTIAL_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProjNoTranslate;
uniform vec3 uCenter;
uniform float uSize;
uniform vec3 uRight;
uniform vec3 uUp;
out vec2 vUV;
void main() {
  vUV = aCorner * 0.5 + 0.5;
  vec3 p = uCenter + (uRight * aCorner.x + uUp * aCorner.y) * uSize;
  vec4 c = uViewProjNoTranslate * vec4(p, 1.0);
  gl_Position = c.xyww;
}
`;

export const CELESTIAL_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
uniform vec3 uColor;
uniform int uIsMoon;
uniform int uPhase;      // 0..7
uniform float uAlpha;
out vec4 fragColor;

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  if (uIsMoon == 1) {
    // Square moon like Minecraft's, with the phase carved out of one side.
    if (max(abs(p.x), abs(p.y)) > 0.85) discard;
    float phase = float(uPhase);
    float cut = (phase - 3.5) / 3.5;   // -1 .. 1
    if (uPhase != 0) {
      float edge = p.x - cut * 1.1;
      if (uPhase < 4 ? edge > 0.0 : edge < 0.0) discard;
    }
    // Craters
    float c = fract(sin(dot(floor(p * 6.0), vec2(12.9898, 78.233))) * 43758.5453);
    vec3 col = uColor * (0.88 + 0.12 * step(0.7, c));
    fragColor = vec4(col, uAlpha);
  } else {
    if (r > 1.0) discard;
    float core = smoothstep(1.0, 0.55, r);
    fragColor = vec4(uColor, uAlpha * core);
  }
}
`;

/** Volumetric-ish cloud layer: a scrolling slab of boxes rendered as quads. */
export const CLOUD_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform vec3 uOffset;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec3 p = aPos + uOffset;
  vWorld = p;
  vNormal = aNormal;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const CLOUD_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
uniform vec3 uColor;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogEnd;
uniform float uAlpha;
out vec4 fragColor;
void main() {
  float shade = vNormal.y > 0.5 ? 1.0 : (vNormal.y < -0.5 ? 0.7 : 0.85);
  float dist = distance(vWorld.xz, uCameraPos.xz);
  float fog = clamp(dist / uFogEnd, 0.0, 1.0);
  vec3 c = mix(uColor * shade, uFogColor, fog * fog);
  fragColor = vec4(c, uAlpha * (1.0 - fog * 0.9));
}
`;

/** Entities: box models sampling a per-mob skin sheet. */
export const ENTITY_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec3 aNormal;

uniform mat4 uViewProj;
uniform mat4 uModel;
out vec2 vUV;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  gl_Position = uViewProj * world;
}
`;

export const ENTITY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vNormal;
in vec3 vWorld;
uniform sampler2D uSkin;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogDensity;
uniform vec3 uLight;         // baked light colour at the entity's position
uniform vec4 uOverlay;       // rgb tint + strength, for hurt flash / creeper swell
uniform float uAlpha;
uniform int uGlowing;
out vec4 fragColor;

void main() {
  vec4 tex = texture(uSkin, vUV);
  if (tex.a < 0.1) discard;
  vec3 n = normalize(vNormal);
  // Two-tone directional shading matching the terrain's face brightness.
  float shade = 0.5 + 0.5 * max(0.0, n.y) + 0.2 * abs(n.x) + 0.1 * abs(n.z);
  shade = clamp(shade, 0.55, 1.0);
  vec3 c = tex.rgb * uLight * shade;
  c = mix(c, uOverlay.rgb, uOverlay.a);
  if (uGlowing == 1) c += vec3(0.25);

  float dist = distance(vWorld, uCameraPos);
  float fog = uFogDensity > 0.0
    ? 1.0 - exp(-uFogDensity * dist)
    : clamp((dist - uFogStart) / max(0.001, uFogEnd - uFogStart), 0.0, 1.0);
  c = mix(c, uFogColor, fog * fog);
  fragColor = vec4(c, tex.a * uAlpha);
}
`;

/** Camera-facing particle quads. */
export const PARTICLE_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aLayer;
uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vColor;
out float vLayer;
out vec3 vWorld;
void main() {
  vUV = aUV;
  vColor = aColor;
  vLayer = aLayer;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const PARTICLE_FS = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUV;
in vec4 vColor;
in float vLayer;
in vec3 vWorld;
uniform sampler2DArray uAtlas;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogEnd;
out vec4 fragColor;
void main() {
  vec4 c;
  if (vLayer < 0.0) {
    c = vColor;                        // untextured, solid colour particle
  } else {
    c = texture(uAtlas, vec3(vUV, vLayer)) * vColor;
  }
  if (c.a < 0.05) discard;
  float dist = distance(vWorld, uCameraPos);
  float fog = clamp(dist / uFogEnd, 0.0, 1.0);
  c.rgb = mix(c.rgb, uFogColor, fog * fog);
  fragColor = c;
}
`;

/** Block selection outline and hit-box debug lines. */
export const LINE_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec3 uOffset;
void main() {
  gl_Position = uViewProj * vec4(aPos + uOffset, 1.0);
}
`;

export const LINE_FS = /* glsl */`#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }
`;

/** Block-breaking crack overlay, drawn over the targeted block. */
export const BREAK_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
uniform mat4 uViewProj;
uniform vec3 uOffset;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uViewProj * vec4(aPos + uOffset, 1.0);
}
`;

export const BREAK_FS = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUV;
uniform sampler2DArray uAtlas;
uniform float uLayer;
out vec4 fragColor;
void main() {
  vec4 c = texture(uAtlas, vec3(vUV, uLayer));
  if (c.a < 0.05) discard;
  fragColor = vec4(0.0, 0.0, 0.0, c.a * 0.75);
}
`;

/**
 * Post-processing: applies the underwater/lava/portal screen tint, a subtle
 * vignette, and the nausea warp, then resolves to the default framebuffer.
 */
export const POST_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const POST_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform vec4 uTint;        // rgb + strength
uniform float uVignette;
uniform float uNausea;
uniform float uTime;
uniform float uHurt;
uniform float uGamma;
out vec4 fragColor;

void main() {
  vec2 uv = vUV;
  if (uNausea > 0.001) {
    // The portal/nausea wobble: a slow rotating pinch centred on the screen.
    vec2 c = uv - 0.5;
    float a = uNausea * 0.25 * sin(uTime * 1.7);
    float s = sin(a), co = cos(a);
    c = mat2(co, -s, s, co) * c;
    c *= 1.0 + uNausea * 0.12 * sin(uTime * 2.3 + length(c) * 12.0);
    uv = c + 0.5;
  }
  vec3 col = texture(uScene, uv).rgb;
  col = mix(col, uTint.rgb, uTint.a);
  if (uHurt > 0.0) col = mix(col, vec3(0.7, 0.0, 0.0), uHurt * 0.35);

  float d = distance(vUV, vec2(0.5));
  col *= 1.0 - uVignette * smoothstep(0.35, 0.85, d);

  col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));
  fragColor = vec4(col, 1.0);
}
`;
