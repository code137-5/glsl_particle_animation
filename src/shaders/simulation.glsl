uniform sampler2D uPositions;
uniform sampler2D uField;   // 12×12 그리드 벡터필드 (RG = 방향, NearestFilter)
uniform float uTime;
uniform float uSpeed;
uniform float uAspect;
uniform float uJitter;
uniform float uLifespan;
uniform vec2 resolution;

#include './noise.glsl'

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec4 data = texture2D(uPositions, uv);
  vec3 pos = data.xyz;
  float life = data.w;

  // 위치(도메인 [-1,1]²)를 필드 텍스처 좌표 [0,1]² 로 변환해 셀의 방향 벡터를 읽음.
  // NearestFilter라 한 셀 안에서는 같은 방향 → 12×12 계단형 벡터필드를 따라 흐름.
  vec2 fieldUV = pos.xy * 0.5 + 0.5;
  vec2 velocity = texture2D(uField, fieldUV).xy;
  pos.xy += velocity * uSpeed;

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
