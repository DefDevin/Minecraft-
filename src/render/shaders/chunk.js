// Terrain shader. One program serves all three passes; the cutout and
// translucent passes differ only in blend/alpha state set by the renderer.

export const CHUNK_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in float aLayer;
layout(location = 3) in uint aPacked;

uniform mat4 uViewProj;
uniform vec3 uChunkOrigin;     // section origin in world space
uniform vec3 uCameraPos;
uniform float uTime;           // seconds, for water/lava animation
uniform int uAnimFrame;        // current frame for animated textures

out vec2 vUV;
out float vLayer;
out vec3 vWorldPos;
flat out uint vNormalIdx;
out float vAO;
out vec2 vLight;               // (sky, block) in 0..1
flat out uint vTint;
flat out float vEmissive;

const vec3 NORMALS[6] = vec3[6](
  vec3(-1.0, 0.0, 0.0), vec3(1.0, 0.0, 0.0),
  vec3(0.0, -1.0, 0.0), vec3(0.0, 1.0, 0.0),
  vec3(0.0, 0.0, -1.0), vec3(0.0, 0.0, 1.0)
);

void main() {
  uint normalIdx = aPacked & 7u;
  uint ao        = (aPacked >> 3) & 3u;
  uint sky       = (aPacked >> 5) & 15u;
  uint blk       = (aPacked >> 9) & 15u;
  uint tint      = (aPacked >> 13) & 7u;
  uint emissive  = (aPacked >> 16) & 15u;

  vec3 world = uChunkOrigin + aPos;

  // Water surface ripple. Only the top face of water moves, and only by a few
  // centimetres, which reads as motion without breaking the block grid.
  if (tint == 3u && normalIdx == 3u) {
    float w = sin(world.x * 0.7 + uTime * 1.7) * cos(world.z * 0.6 + uTime * 1.3);
    world.y += w * 0.022 - 0.012;
  }

  vUV = aUV;
  vLayer = aLayer;
  vWorldPos = world;
  vNormalIdx = normalIdx;
  vAO = float(ao) / 3.0;
  vLight = vec2(float(sky), float(blk)) / 15.0;
  vTint = tint;
  vEmissive = float(emissive) / 15.0;

  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const CHUNK_FS = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUV;
in float vLayer;
in vec3 vWorldPos;
flat in uint vNormalIdx;
in float vAO;
in vec2 vLight;
flat in uint vTint;
flat in float vEmissive;

uniform sampler2DArray uAtlas;
uniform vec3 uCameraPos;
uniform float uSkyBrightness;   // 0..1 daylight factor
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogDensity;      // >0 switches to exponential (underwater/nether)
uniform vec3 uGrassColor;
uniform vec3 uFoliageColor;
uniform vec3 uWaterColor;
uniform vec3 uTorchColor;
uniform vec3 uSkyLightColor;
uniform float uAlphaCutoff;
uniform float uAmbient;         // dimension ambient light floor
uniform int uUnderwater;
uniform float uTime;
uniform float uNightVision;

out vec4 fragColor;

// Directional face shading — Minecraft's fixed per-face brightness. It is what
// makes a flat-lit voxel world read as three-dimensional at all.
const float FACE_SHADE[6] = float[6](0.6, 0.6, 0.5, 1.0, 0.8, 0.8);

// The vanilla light curve: each level down multiplies brightness, so the
// falloff is steep near a torch and gentle far away.
float lightCurve(float level) {
  return pow(0.86, (1.0 - level) * 15.0);
}

void main() {
  vec4 tex = texture(uAtlas, vec3(vUV, vLayer));
  if (tex.a < uAlphaCutoff) discard;

  vec3 color = tex.rgb;

  // Biome tinting. The texture is painted greyscale-friendly so a straight
  // multiply lands on the right hue.
  if (vTint == 1u) color *= uGrassColor;
  else if (vTint == 2u) color *= uFoliageColor;
  else if (vTint == 3u) color *= uWaterColor;

  float skyAmount = lightCurve(vLight.x) * uSkyBrightness;
  float blockAmount = lightCurve(vLight.y);
  vec3 light = uSkyLightColor * skyAmount + uTorchColor * blockAmount;
  light = max(light, vec3(uAmbient));

  // Ambient occlusion, softened so corners darken without going to black.
  float ao = mix(0.55, 1.0, vAO);

  float shade = FACE_SHADE[vNormalIdx];
  vec3 lit = color * light * ao * shade;

  // Emissive blocks (lava, glowstone faces, fire) keep their own brightness.
  lit = mix(lit, color * (0.85 + 0.15 * sin(uTime * 2.0)), vEmissive * 0.85);

  if (uNightVision > 0.0) {
    lit = mix(lit, color * ao * shade * 1.15, uNightVision);
  }

  // Fog
  float dist = distance(vWorldPos, uCameraPos);
  float fog;
  if (uFogDensity > 0.0) {
    fog = 1.0 - exp(-uFogDensity * dist);
  } else {
    fog = clamp((dist - uFogStart) / max(0.001, uFogEnd - uFogStart), 0.0, 1.0);
    fog = fog * fog;
  }
  lit = mix(lit, uFogColor, fog);

  float alpha = tex.a;
  if (vTint == 3u) {
    // Water gets a slight fresnel so it is more opaque at grazing angles.
    vec3 v = normalize(uCameraPos - vWorldPos);
    float f = 1.0 - abs(v.y);
    alpha = mix(0.62, 0.88, f * f);
    if (uUnderwater == 1) alpha = 0.35;
  }

  fragColor = vec4(lit, alpha);
}
`;
