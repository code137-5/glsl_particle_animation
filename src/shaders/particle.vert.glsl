attribute vec2 aUV;

uniform sampler2D uPositions;
uniform float uPointSize;

void main() {
  vec3 pos = texture2D(uPositions, aUV).xyz;
  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);

  gl_PointSize = uPointSize * (1.0 / -mvPos.z);
  gl_Position = projectionMatrix * mvPos;
}
