uniform sampler2D uPositions;
uniform float uTime;
uniform float uSpeed;
uniform float uNoiseScale;
uniform float uAspect;
uniform float uJitter;
uniform float uEvolve;
uniform float uLifespan;
uniform vec2 resolution;

#include './noise.glsl'

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec4 data = texture2D(uPositions, uv);
  vec3 pos = data.xyz;
  float life = data.w;

  // uEvolve가 0이면 z 슬라이스가 고정 → 같은 좌표는 항상 같은 방향(정적 벡터 필드).
  // >0이면 시간에 따라 필드가 천천히 변형됨.
  vec3 velocity = perlinFlow(vec3(pos.xy * uNoiseScale, uTime * uEvolve));
  pos.xy += velocity.xy * uSpeed;

  // 흐름선에 과하게 뭉치지 않도록 매 프레임 약한 무작위 흔들림
  vec2 jitter = hash22(uv + uTime) - 0.5;
  pos.xy += jitter * uJitter;

  // 나이 증가 (compute 1회 = 1프레임)
  life += 1.0;

  // 화면을 벗어나거나 수명이 다하면 삭제하고 화면 안 랜덤 위치에 재생성.
  // 수명 덕분에 흐름선에 갇혀 화면을 못 벗어나는 파티클도 계속 순환됨.
  bool offscreen = abs(pos.x) > uAspect || abs(pos.y) > 1.0;
  bool expired = life > uLifespan;
  if (offscreen || expired) {
    vec2 r = hash22(uv * 1.37 + uTime);
    pos.x = (r.x * 2.0 - 1.0) * uAspect; // x ∈ [-aspect, aspect]
    pos.y = r.y * 2.0 - 1.0;             // y ∈ [-1, 1]
    life = 0.0;
  }
  pos.z = 0.0;

  // w 채널에 나이를 저장해 다음 프레임으로 이어받음
  gl_FragColor = vec4(pos, life);
}
