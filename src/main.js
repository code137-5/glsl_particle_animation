import * as THREE from 'three'
import { GPUCompute } from './GPUCompute.js'
import particleVert from './shaders/particle.vert.glsl'
import particleFrag from './shaders/particle.frag.glsl'

// 텍스처 크기 — 64×64 = 총 4,096개의 파티클
const TEXTURE_SIZE = 64

// 렌더러 설정
const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // 고해상도 디스플레이 대응 (최대 2배)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.autoClearColor = false // 트레일 효과를 위해 자동 화면 초기화 비활성화
document.body.appendChild(renderer.domElement)

// 카메라 & 씬
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100)
camera.position.set(0, 0, 3)

const scene = new THREE.Scene()

// 트레일 씬 — 이전 프레임을 서서히 페이드아웃시키는 전체화면 쿼드
const trailScene = new THREE.Scene()
const trailCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const trailMat   = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.05, // 낮을수록 트레일이 길게 남음
  depthWrite: false,
})
trailScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMat))

// GPGPU 시뮬레이션 초기화
const gpuCompute = new GPUCompute(renderer, TEXTURE_SIZE)

// 파티클 지오메트리 — 각 포인트가 GPGPU 텍스처의 UV 좌표를 저장
function buildParticleGeometry(size) {
  const count = size * size
  const uvs   = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    uvs[i * 2 + 0] = (i % size + 0.5) / size       // U 좌표
    uvs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size // V 좌표
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('aUV', new THREE.BufferAttribute(uvs, 2))
  // Three.js가 드로우 콜을 컬링하지 않도록 더미 position 속성 추가
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  return geo
}

// 파티클 셰이더 유니폼 — GPGPU 위치 텍스처를 전달
const particleUniforms = {
  uPositions: { value: gpuCompute.texture },
  uPointSize: { value: 16.0 },
}

// 파티클 셰이더 머티리얼
const particleMat = new THREE.ShaderMaterial({
  vertexShader:   particleVert,
  fragmentShader: particleFrag,
  uniforms:       particleUniforms,
  blending:       THREE.AdditiveBlending, // 가산 블렌딩으로 빛나는 효과
  depthWrite:     false,
  transparent:    true,
})

// 파티클 메시 생성 및 씬에 추가
const particles = new THREE.Points(buildParticleGeometry(TEXTURE_SIZE), particleMat)
scene.add(particles)

// 창 크기 변경 대응
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
})

// 애니메이션 루프
const clock = new THREE.Clock()

function animate() {
  requestAnimationFrame(animate)

  const elapsed = clock.getElapsedTime()

  // 1단계: 이전 프레임 페이드 (트레일 효과)
  renderer.render(trailScene, trailCam)

  // 2단계: GPGPU 시뮬레이션 스텝 실행
  gpuCompute.compute(elapsed)

  // 3단계: 파티클 위치 텍스처 갱신 후 렌더링
  particleUniforms.uPositions.value = gpuCompute.texture
  renderer.render(scene, camera)
}

animate()
