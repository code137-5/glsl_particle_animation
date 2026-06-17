# CLAUDE.md

Claude Code(claude.ai/code)가 이 저장소에서 작업할 때 참고하는 가이드.
**매번 전체 파일을 읽지 않아도 되도록** 아키텍처 맵을 여기에 유지한다. 구조가 바뀌면 이 문서를 갱신할 것.

## 프로젝트 개요

서울시 행정동 경계(GeoJSON) 기반 **GPGPU 파티클 플로우 애니메이션**.
각 행정동이 하나의 방향 벡터를 가지며, 파티클이 그 동 안에 들어오면 해당 벡터를
velocity로 적용받아 흐른다. 동별 실제 벡터(예: 30분 이내 이동량)는 추후 Python으로
산정해 GeoJSON `properties`에 넣을 예정이고, **현재는 placeholder로 동별 Perlin 벡터**를 쓴다.

## 기술 스택 / 실행

- **번들러**: Vite 6 (ES 모듈). 셰이더는 `vite-plugin-glsl`로 `.glsl`을 문자열 import.
- **렌더링**: Three.js (r0.176). 오쏘 카메라 2D, GPGPU는 ping-pong 렌더타깃.
- 명령: `npm install` → `npm run dev`(개발 서버) / `npm run build` / `npm run preview`
- 조작: **G 키** = 벡터필드 오버레이(경계선+화살표) 토글.

## 데이터 흐름 (핵심)

```
GeoJSON(행정동)                FlowField (폴백)
   │ rasterize                     │ perlin 격자
   ▼                               ▼
DistrictField.texture  ─┐   ┌─ FlowField.texture
   (R=vx,G=vy,B=mask)    └─┬─┘   (uField)
                          ▼
        GPUCompute (simulation.glsl, ping-pong)
        파티클 위치 += uField 샘플 벡터 · uSpeed
        화면밖/수명/마스크밖 → uSpawn(서울 안)에서 재생성
                          ▼
        particle.vert/frag.glsl → THREE.Points 렌더 (가산 블렌딩 + 트레일)
```

런타임 셰이더는 **"파티클 위치 → uField 1회 샘플 → 그 동의 벡터"** 뿐.
비정형 행정동 경계 판정은 **빌드 시 텍스처 래스터화로 한 번만** 처리한다.

## 파일별 책임

| 파일 | 책임 |
|---|---|
| `src/main.js` | 진입점. 필드 로드(async) → 렌더러/카메라/씬/트레일/오버레이 구성 → 애니메이션 루프. `createField()`가 DistrictField 우선, 실패 시 FlowField 폴백. |
| `src/DistrictField.js` | **핵심.** GeoJSON 로드·투영·동별 벡터 산정·폴리곤 래스터화 → `texture`(필드)·`spawnTexture`·`interior`(서울 안 위치)·`buildBoundaries()`/`buildArrows()`(오버레이) 생성. |
| `src/FlowField.js` | 폴백용 Perlin 격자 필드. `perlin2()`를 export(DistrictField가 동별 벡터에 재사용). |
| `src/GPUCompute.js` | GPGPU 시뮬레이션. read/write 렌더타깃 ping-pong, `simUniforms`, 초기 위치 시드(서울 안 `interior` 사용), spawn 텍스처 관리. |
| `src/shaders/simulation.glsl` | 파티클 갱신 셰이더. uField 샘플 → 이동 → 화면밖/수명/마스크밖이면 uSpawn에서 재생성. |
| `src/shaders/particle.vert/frag.glsl` | 위치 텍스처에서 좌표 읽어 점 렌더, 원형 글로우. |
| `src/shaders/noise.glsl` | snoise/hash22 등 유틸(시뮬에서 hash22 사용). |

## 좌표계 / 핵심 상수

- 도메인: `x ∈ [-aspect, aspect]`, `y ∈ [-1, 1]`. aspect는 GeoJSON bbox에서 **위도 보정**(`cos(meanLat)`)해 계산. 폴백 모드는 aspect=1.
- 필드 UV(셰이더): `vec2(pos.x/uAspect, pos.y) * 0.5 + 0.5`.
- 상수: `TEXTURE_SIZE=128`(파티클 128²), `FIELD_RES=512`(래스터화), `spawnRes=128`. NearestFilter로 동 경계에서 벡터가 또렷이 전환.
- DataTexture는 행 0이 아래(v=0) → 래스터화 시 캔버스(y-down)와 **상하 반전**해 기록.

## 데이터 준비 (GeoJSON)

- 경로: `public/seoul_dong.geojson` (Vite가 `/seoul_dong.geojson`로 서빙). 없으면 콘솔 경고 후 Perlin 격자로 폴백.
- 좌표계: lon/lat 또는 미터 투영(현재 파일은 **EPSG:5186**) 자동 감지. bbox 등방 선형 투영이라 벡터는 **폴리곤과 같은 CRS**(=5186) 축 성분으로 주면 화면 각도가 그대로 맞음(easting→오른쪽, northing→위). `Polygon`/`MultiPolygon` 지원.
- **방향 × 강도 구조**: 필드 텍스처 `R=vx,G=vy`는 단위방향 × strength(길이=상대속도), `B=mask`. 동별 강도는 최댓값 정규화 후 `[strengthFloor,1]` 로 매핑되어 가장 센 동이 전역 `uSpeed`.
- **실데이터 연동 지점**: `DistrictField._districtVectorRaw()` — feature `properties`에 `vector_x_wmean`/`vector_y_wmean`(현재 파일이 채우고 있는 실데이터, **방향만 사용·세기 무시 → 균일 속도**), `vx/vy`(길이=강도), 또는 `angle`(+`strength`/`mag`)가 있으면 placeholder 대신 자동 사용. 우선순위는 `vector_x_wmean/y` → `vx/vy` → `angle` 순.

## 컨벤션

- 주석은 한국어. 셰이더 파일은 `vite-plugin-glsl`로 import되는 `.glsl`.
