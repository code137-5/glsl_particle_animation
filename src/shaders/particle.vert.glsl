attribute vec2 aUV;

uniform sampler2D uPositions;
uniform float uPointSize;

void main() {
  vec3 pos = texture2D(uPositions, aUV).xyz;

  // 정사영(2D)이라 깊이에 따른 크기 변화 없이 상수 크기 사용
  gl_PointSize = uPointSize*0.2;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
