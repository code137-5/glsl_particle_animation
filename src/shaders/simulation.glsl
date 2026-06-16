uniform sampler2D uPositions;
uniform sampler2D uField;   // 벡터필드 (R=vx, G=vy, B=mask, NearestFilter)
uniform sampler2D uSpawn;   // 서울 영역 안 무작위 재생성 위치 (RG = 도메인 x,y)
uniform vec2 uSpawnRes;     // uSpawn 텍스처 해상도
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

  // 위치(도메인 x∈[-aspect,aspect], y∈[-1,1])를 필드 텍스처 좌표 [0,1]² 로 변환.
  // NearestFilter라 한 행정동 안에서는 같은 방향 → 동 경계에서 벡터가 또렷이 전환됨.
  vec2 fieldUV = vec2(pos.x / uAspect, pos.y) * 0.5 + 0.5;
  vec3 fieldVal = texture2D(uField, fieldUV).xyz;
  vec2 velocity = fieldVal.xy;
  float mask = fieldVal.z; // 서울 내부 1 / 밖 0
  pos.xy += velocity * uSpeed;

  // 흐름선에 과하게 뭉치지 않도록 매 프레임 약한 무작위 흔들림
  vec2 jitter = hash22(uv + uTime) - 0.5;
  pos.xy += jitter * uJitter;

  // 나이 증가 (compute 1회 = 1프레임)
  life += 1.0;

  // 화면 이탈·수명 종료·서울 영역 이탈 시 삭제하고 서울 안 랜덤 위치에 재생성.
  // 수명 덕분에 흐름선에 갇혀 못 빠져나가는 파티클도 계속 순환됨.
  bool offscreen = abs(pos.x) > uAspect || abs(pos.y) > 1.0;
  bool expired = life > uLifespan;
  bool outside = mask < 0.5; // 행정동 경계 밖으로 흘러나감
  if (offscreen || expired || outside) {
    // uSpawn(서울 내부 위치 목록)에서 무작위 텍셀을 골라 그 위치로 재생성
    vec2 s = hash22(uv * 1.37 + uTime);
    vec2 spawnUV = (floor(s * uSpawnRes) + 0.5) / uSpawnRes;
    pos.xy = texture2D(uSpawn, spawnUV).xy;
    life = 0.0;
  }
  pos.z = 0.0;

  // w 채널에 나이를 저장해 다음 프레임으로 이어받음
  gl_FragColor = vec4(pos, life);
}
