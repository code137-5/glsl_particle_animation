uniform sampler2D uPositions;
uniform float uTime;
uniform float uSpeed;
uniform float uNoiseScale;
uniform vec2 resolution;

#include './noise.glsl'

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec3 pos = texture2D(uPositions, uv).xyz;

  vec3 velocity = curlNoise(pos * uNoiseScale + uTime * 0.1);
  pos += velocity * uSpeed;

  // Wrap position back into [-1, 1] cube
  pos = mod(pos + 1.0, 2.0) - 1.0;

  gl_FragColor = vec4(pos, 1.0);
}
