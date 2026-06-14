import * as THREE from "three";
import { GPUCompute } from "./GPUCompute.js";
import { FlowField } from "./FlowField.js";
import particleVert from "./shaders/particle.vert.glsl";
import particleFrag from "./shaders/particle.frag.glsl";

// 화면 크기 — 600×600 정사각형
const SIZE = 600;
// 그리드 분할 — 가로/세로 12칸
const GRID = 12;
// 텍스처 크기 — 128×128 = 16,384개의 파티클
const TEXTURE_SIZE = 128;

// 렌더러 설정 (정사각형이므로 aspect = 1)
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(SIZE, SIZE);
renderer.autoClearColor = false; // 트레일 효과를 위해 자동 화면 초기화 비활성화
document.body.appendChild(renderer.domElement);

// 카메라 & 씬 — 도메인은 정사각형 x∈[-1,1], y∈[-1,1]
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.set(0, 0, 1);

const scene = new THREE.Scene();

// ── 12×12 Perlin 벡터필드 생성 ──────────────────────────────────────────────
// 각 셀에 perlin 노이즈 값을 줘서 방향을 정한다. 같은 필드를
// (1) 파티클 시뮬레이션의 입력 텍스처, (2) 화살표 시각화 양쪽에 그대로 사용.
const field = new FlowField(GRID, 0.2, Math.PI);

// 벡터필드 오버레이 (격자선 + 화살표) — G 키로 토글
const overlayScene = new THREE.Scene();
overlayScene.add(field.buildGrid());
overlayScene.add(field.buildArrows());
let showField = true;

// 트레일 씬 — 이전 프레임을 서서히 페이드아웃시키는 전체화면 쿼드
const trailScene = new THREE.Scene();
const trailCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const trailMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.04, // 낮을수록 트레일이 길게 남음
  depthWrite: false,
});
trailScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMat));

// GPGPU 시뮬레이션 초기화 — 12×12 필드 텍스처를 입력으로 전달
const gpuCompute = new GPUCompute(renderer, TEXTURE_SIZE, 1, field.texture);

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

// 파티클 셰이더 머티리얼
const particleMat = new THREE.ShaderMaterial({
  vertexShader: particleVert,
  fragmentShader: particleFrag,
  uniforms: particleUniforms,
  blending: THREE.AdditiveBlending, // 가산 블렌딩으로 빛나는 효과
  depthWrite: false,
  transparent: true,
});

// 파티클 메시 생성 및 씬에 추가
const particles = new THREE.Points(
  buildParticleGeometry(TEXTURE_SIZE),
  particleMat,
);
scene.add(particles);

// G 키로 벡터필드 화살표 오버레이 토글
window.addEventListener("keydown", (e) => {
  if (e.key === "g" || e.key === "G") showField = !showField;
});

// ── 마우스로 화살표 방향 편집 ────────────────────────────────────────────────
// 셀을 클릭한 채 드래그하면, 처음 누른 셀의 화살표가 커서 쪽을 향하도록 설정된다.
// 텍스처가 즉시 갱신되므로 파티클 흐름도 실시간으로 따라온다.
const canvas = renderer.domElement;
canvas.style.cursor = "crosshair";
let activeCell = null; // 편집 중인 셀 { i, j, cx, cy }

// 마우스 이벤트 좌표 → 도메인 좌표 [-1,1]² (Orthographic 카메라와 1:1 대응)
function toDomain(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * 2 - 1,
    y: -(((e.clientY - r.top) / r.height) * 2 - 1), // 화면 Y는 아래로 증가 → 반전
  };
}

function aimAt(x, y) {
  if (!activeCell) return;
  // 셀 중심에서 커서를 향하는 벡터로 방향 설정
  field.setCellDir(activeCell.i, activeCell.j, x - activeCell.cx, y - activeCell.cy);
}

canvas.addEventListener("pointerdown", (e) => {
  const { x, y } = toDomain(e);
  const { i, j } = field.cellAt(x, y);
  const c = field.cellCenter(i, j);
  activeCell = { i, j, cx: c.x, cy: c.y };
  showField = true; // 편집할 땐 화살표가 보이도록
  aimAt(x, y);
  canvas.setPointerCapture(e.pointerId); // 캔버스 밖으로 나가도 드래그 유지
});

canvas.addEventListener("pointermove", (e) => {
  if (!activeCell) return;
  const { x, y } = toDomain(e);
  aimAt(x, y);
});

canvas.addEventListener("pointerup", () => {
  activeCell = null;
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

  // 4단계: 벡터필드 화살표를 파티클 위에 덧그림 (토글 시)
  if (showField) renderer.render(overlayScene, camera);
}

animate();
