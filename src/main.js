import * as THREE from "three";
import { GPUCompute } from "./GPUCompute.js";
import { FlowField } from "./FlowField.js";
import { DistrictField } from "./DistrictField.js";
import particleVert from "./shaders/particle.vert.glsl";
import particleFrag from "./shaders/particle.frag.glsl";

// 화면 세로 크기 (가로는 벡터필드의 종횡비 aspect 에 맞춰 결정)
const SIZE = window.innerHeight;
// 폴백(Perlin 격자) 모드의 그리드 분할
const GRID = 24;
// 텍스처 크기 — 128×128 = 16,384개의 파티클
const TEXTURE_SIZE = 128;

// GeoJSON 경로 (Vite는 public/ 를 루트로 서빙)
const GEOJSON_URL = "/seoul_dong.geojson";

// ── 벡터필드 모드 생성 ───────────────────────────────────────────────────────
// 두 모드를 모두 만들어 둔다(버튼으로 런타임 토글). 두 모드는 같은 aspect(서울 종횡비)를
// 공유하므로 토글해도 카메라/캔버스가 흔들리지 않는다.
//   · 서울 행정동(DistrictField): GeoJSON 로드 성공 시에만. interior 기반 스폰.
//   · 그리드(FlowField): Perlin 격자. 서울 aspect로 그려 캔버스를 공유.
// 반환: { modes:[{name,texture,spawn,overlays}], aspect }. GeoJSON 실패 시 그리드 단독.
async function buildModes() {
  let district = null;
  let aspect = 1;
  try {
    const df = await DistrictField.load(GEOJSON_URL);
    console.log(
      `행정동 ${df.districts.length}개 로드 · aspect=${df.aspect.toFixed(3)}`,
    );
    aspect = df.aspect;
    district = {
      name: "서울 행정동",
      texture: df.texture,
      spawn: {
        texture: df.spawnTexture,
        res: df.spawnRes,
        interior: df.interior,
      },
      overlays: [df.buildBoundaries(), df.buildArrows()],
    };
  } catch (e) {
    console.warn(`GeoJSON 로드 실패 → 그리드 단독: ${e.message}`);
  }

  // 그리드 모드는 서울 aspect(없으면 1)로 생성 → 캔버스 비율 공유
  const ff = new FlowField(GRID, 0.2, Math.PI, aspect);
  const grid = {
    name: "그리드",
    texture: ff.texture,
    spawn: null,
    overlays: [ff.buildGrid(), ff.buildArrows()],
  };

  const modes = district ? [district, grid] : [grid];
  return { modes, aspect };
}

async function init() {
  const { modes, aspect } = await buildModes();
  let current = 0; // 현재 모드 인덱스

  // 렌더러 — 종횡비 aspect 에 맞춰 가로 크기 결정
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(Math.round(SIZE * aspect), SIZE);
  renderer.autoClearColor = false; // 트레일 효과를 위해 자동 화면 초기화 비활성화
  document.body.appendChild(renderer.domElement);

  // 카메라 & 씬 — 도메인 x∈[-aspect,aspect], y∈[-1,1]
  const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 1);
  const scene = new THREE.Scene();

  // 벡터필드 오버레이 (경계선 + 화살표) — G 키로 토글, 모드별로 교체됨(applyMode)
  const overlayScene = new THREE.Scene();
  let showField = true;

  // 트레일 씬 — 이전 프레임을 서서히 페이드아웃시키는 전체화면 쿼드
  const trailScene = new THREE.Scene();
  const trailCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const trailMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.01, // 낮을수록 트레일이 길게 남음
    depthWrite: false,
  });
  trailScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMat));

  // GPGPU 시뮬레이션 초기화 — 필드 텍스처 + 서울 영역 스폰 정보 전달
  const gpuCompute = new GPUCompute(
    renderer,
    TEXTURE_SIZE,
    aspect,
    modes[current].texture,
    modes[current].spawn,
  );

  // 모드 적용: 오버레이를 갈아끼우고 시뮬 필드 텍스처·스폰을 교체(파티클 재시드).
  let currentOverlays = [];
  function applyMode(i) {
    current = i;
    const mode = modes[i];
    currentOverlays.forEach((o) => overlayScene.remove(o));
    currentOverlays = mode.overlays;
    currentOverlays.forEach((o) => overlayScene.add(o));
    gpuCompute.setField({ texture: mode.texture, aspect, spawn: mode.spawn });
  }
  applyMode(current); // 초기 모드(서울 우선) 적용

  // 파티클 지오메트리 — 각 포인트가 GPGPU 텍스처의 UV 좌표를 저장
  function buildParticleGeometry(size) {
    const count = size * size;
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uvs[i * 2 + 0] = ((i % size) + 0.5) / size; // U 좌표
      uvs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size; // V 좌표
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("aUV", new THREE.BufferAttribute(uvs, 2));
    // Three.js가 드로우 콜을 컬링하지 않도록 더미 position 속성 추가
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(count * 3), 3),
    );
    return geo;
  }

  // 파티클 셰이더 유니폼 — GPGPU 위치 텍스처를 전달
  const particleUniforms = {
    uPositions: { value: gpuCompute.texture },
    uPointSize: { value: 14.0 },
  };

  const particleMat = new THREE.ShaderMaterial({
    vertexShader: particleVert,
    fragmentShader: particleFrag,
    uniforms: particleUniforms,
    blending: THREE.AdditiveBlending, // 가산 블렌딩으로 빛나는 효과
    depthWrite: false,
    transparent: true,
  });

  const particles = new THREE.Points(
    buildParticleGeometry(TEXTURE_SIZE),
    particleMat,
  );
  scene.add(particles);

  // G 키로 벡터필드 오버레이 토글
  window.addEventListener("keydown", (e) => {
    if (e.key === "g" || e.key === "G") showField = !showField;
  });

  // 화면 위 버튼 — 클릭하면 다음 모드로 전환. 모드가 하나뿐이면 숨김.
  const modeButton = document.createElement("button");
  modeButton.style.cssText =
    "position:fixed;top:12px;left:12px;z-index:10;padding:8px 14px;" +
    "font:14px/1.2 sans-serif;color:#cfe;background:rgba(20,30,40,0.7);" +
    "border:1px solid #3a5;border-radius:6px;cursor:pointer;";
  const updateButtonLabel = () => {
    modeButton.textContent = `모드: ${modes[current].name}`;
  };
  updateButtonLabel();
  if (modes.length < 2) {
    modeButton.style.display = "none"; // 전환 대상 없음
  }
  modeButton.addEventListener("click", () => {
    applyMode((current + 1) % modes.length);
    updateButtonLabel();
  });
  document.body.appendChild(modeButton);

  // 애니메이션 루프
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const elapsed = clock.getElapsedTime();

    // 1단계: 이전 프레임 페이드 (트레일 효과)
    renderer.render(trailScene, trailCam);

    // 2단계: GPGPU 시뮬레이션 스텝 실행
    gpuCompute.compute(elapsed);

    // 3단계: 파티클 위치 텍스처 갱신 후 렌더링
    particleUniforms.uPositions.value = gpuCompute.texture;
    renderer.render(scene, camera);

    // 4단계: 벡터필드 오버레이를 파티클 위에 덧그림 (토글 시)
    if (showField) renderer.render(overlayScene, camera);
  }
  animate();
}

init();
