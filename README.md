# 서울 행정동 파티클 플로우 애니메이션

서울시 **행정동 경계(GeoJSON)** 를 벡터필드로 삼아, 16,384개의 파티클이
각 행정동의 방향 벡터를 따라 흐르는 GPGPU 파티클 애니메이션입니다.

각 행정동은 하나의 방향 벡터를 가지며, 파티클이 그 동 영역 안에 들어오면 해당 벡터를
속도로 적용받아 흐릅니다. 행정동 간 흐름(예: **30분 이내 이동량**)을 시각화하려는 것이
최종 목표이며, 동별 실제 벡터값은 추후 Python 등으로 산정해 GeoJSON에 채워 넣습니다.
현재는 그 자리에 **Perlin 노이즈 기반 placeholder 벡터**를 넣어 시각화합니다.

## 실행

```bash
npm install
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드 (dist/)
npm run preview  # 빌드 결과 미리보기
```

브라우저에서 **G 키**를 누르면 행정동 경계선 + 방향 화살표 오버레이를 켜고 끌 수 있습니다.

## 데이터 준비

1. 서울시 행정동 경계 GeoJSON을 `public/seoul_dong.geojson` 에 둡니다.
   - 좌표는 `[경도, 위도]`, `Polygon` / `MultiPolygon` 모두 지원합니다.
   - 파일이 없으면 콘솔 경고와 함께 **Perlin 격자 필드로 자동 폴백**되어 앱은 계속 동작합니다.
2. (선택) 동별 실제 벡터가 있으면 각 feature의 `properties` 에 넣습니다.
   - `vx`, `vy` — 폴리곤과 같은 좌표계(현재 EPSG:5186) 축 성분. **벡터 길이가 곧 강도(속도)**.
   - **또는** `angle`(라디안) + `strength`(또는 `mag`) — 방향·강도를 분리해 줄 때.
   - 이 값이 있으면 placeholder 대신 자동으로 사용됩니다. 강도는 동들 최댓값 기준으로 정규화되어 속도 차이로 표현됩니다.

## 동작 원리

행정동은 비정형(불규칙) 다각형이지만, **"어느 동에 속하는가" 판정을 매 프레임 셰이더에서
하지 않고 텍스처로 한 번 구워둡니다(rasterize).**

1. GeoJSON을 읽어 위도 보정 종횡비로 화면 도메인에 투영합니다.
2. 각 행정동의 중심점에서 벡터를 정하고(placeholder=Perlin, 또는 실데이터), 폴리곤을
   오프스크린 캔버스에 채워 **벡터필드 텍스처**(R=vx, G=vy, B=마스크)를 만듭니다.
3. GPGPU 시뮬레이션은 매 프레임 각 파티클 위치에서 이 텍스처를 1회 샘플해 속도를 적용합니다.
4. 파티클은 **서울 영역 안에서만** 생성·순환합니다(영역을 벗어나면 서울 안 무작위 위치로 재생성).

자세한 아키텍처는 [`CLAUDE.md`](./CLAUDE.md) 를 참고하세요.

## 주요 파일

- `src/DistrictField.js` — GeoJSON → 벡터필드 텍스처 래스터화 (핵심)
- `src/GPUCompute.js` — GPGPU 파티클 시뮬레이션 (ping-pong 렌더타깃)
- `src/shaders/simulation.glsl` — 파티클 위치 갱신 셰이더
- `src/FlowField.js` — Perlin 격자 폴백 필드
- `src/main.js` — 진입점, 씬 구성 및 렌더 루프

## 기술 스택

Vite · Three.js · vite-plugin-glsl · WebGL GPGPU
