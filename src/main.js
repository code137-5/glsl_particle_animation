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

// ── 벡터필드 생성 ────────────────────────────────────────────────────────────
// 서울 행정동 GeoJSON 기반(DistrictField)을 우선 시도, 실패하면 Perlin 격자로 폴백.
// 반환: { texture, aspect, spawn, overlays } — 이후 파이프라인은 동일하게 동작.
async function createField() {
  try {
    const df = await DistrictField.load(GEOJSON_URL);
    console.log(
      `행정동 ${df.districts.length}개 로드 · aspect=${df.aspect.toFixed(3)}`,
    );
    return {
      texture: df.texture,
      aspect: df.aspect,
      spawn: { texture: df.spawnTexture, res: df.spawnRes, interior: df.interior },
      overlays: [df.buildBoundaries(), df.buildArrows()],
    };
  } catch (e) {
    console.warn(`GeoJSON 로드 실패 → Perlin 격자 폴백: ${e.message}`);
    const ff = new FlowField(GRID, 0.2, Math.PI);
    return {
      texture: ff.texture,
      aspect: 1,
      spawn: null,
      overlays: [ff.buildGrid(), ff.buildArrows()],
    };
  }
}

async function init() {
  const field = await createField();
  const aspect = field.aspect;

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

  // 벡터필드 오버레이 (경계선 + 화살표) — G 키로 토글
  const overlayScene = new THREE.Scene();
  field.overlays.forEach((o) => overlayScene.add(o));
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
    field.texture,
    field.spawn,
  );

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
