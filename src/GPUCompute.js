import * as THREE from "three";
import simulationFrag from "./shaders/simulation.glsl";

const VERT = /* glsl */ `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

// 파티클 수명(프레임 단위). 이 시간이 지나면 화면 안 랜덤 위치로 재생성됨.
const LIFESPAN = 1000;
// 재생성 주기 = 수명의 1/3. 초기 나이를 이 범위에 고르게 분산해 두면
// 매 프레임 일정 비율씩 계속 재생성돼, 처음 시드처럼 끊김 없이 새 파티클이 생성된다.
const SPAWN_PERIOD = LIFESPAN / 3;

export class GPUCompute {
  // spawn: { texture, res, interior } — 서울 영역 안 재생성/초기 위치 정보(선택).
  //   interior 는 Float32 [x,y, x,y, ...] (없으면 도메인 전역에 무작위 시드).
  constructor(renderer, textureSize, aspect = 1, fieldTexture = null, spawn = null) {
    this.renderer = renderer;
    this.textureSize = textureSize;
    this.count = textureSize * textureSize;
    this.aspect = aspect;
    this.fieldTexture = fieldTexture;
    this.spawn = spawn;

    const rtOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      depthBuffer: false,
    };
    this.read = new THREE.WebGLRenderTarget(
      textureSize,
      textureSize,
      rtOptions,
    );
    this.write = new THREE.WebGLRenderTarget(
      textureSize,
      textureSize,
      rtOptions,
    );

    this._initPositions();
    this._initQuad();
  }

  _initPositions() {
    const size = this.textureSize;
    const data = new Float32Array(size * size * 4);
    const interior = this.spawn && this.spawn.interior;
    const nInterior = interior ? interior.length / 2 : 0;
    for (let i = 0; i < size * size; i++) {
      if (nInterior > 0) {
        // 서울 영역 안에서 균등하게 초기 위치 시드
        const k = Math.floor(Math.random() * nInterior) * 2;
        data[i * 4 + 0] = interior[k];
        data[i * 4 + 1] = interior[k + 1];
      } else {
        data[i * 4 + 0] = (Math.random() * 2 - 1) * this.aspect; // x ∈ [-aspect, aspect]
        data[i * 4 + 1] = Math.random() * 2 - 1; // y ∈ [-1, 1]
      }
      data[i * 4 + 2] = 0.0; // z = 0 (2D 평면)
      data[i * 4 + 3] = Math.random() * SPAWN_PERIOD; // 초기 나이를 주기 안에 분산 → 재생성이 매 프레임 고르게 일어남
    }
    const tex = new THREE.DataTexture(
      data,
      this.textureSize,
      this.textureSize,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    tex.needsUpdate = true;

    // Render initial data into read target
    const initMat = new THREE.MeshBasicMaterial({ map: tex });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), initMat);
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene.add(quad);
    this.renderer.setRenderTarget(this.read);
    this.renderer.render(scene, cam);
    this.renderer.setRenderTarget(null);
    initMat.dispose();
    tex.dispose();
  }

  // 재생성 위치 텍스처. spawn 이 주어지면 그것을(서울 영역), 아니면 도메인 전역 기본값.
  _spawnTexture() {
    if (this.spawn && this.spawn.texture) {
      this._spawnRes = this.spawn.res;
      return this.spawn.texture;
    }
    const S = 128;
    this._spawnRes = S;
    const data = new Float32Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      data[i * 4 + 0] = (Math.random() * 2 - 1) * this.aspect;
      data[i * 4 + 1] = Math.random() * 2 - 1;
      data[i * 4 + 3] = 1.0;
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  _initQuad() {
    const spawnTex = this._spawnTexture();
    this.simUniforms = {
      uPositions: { value: this.read.texture },
      uField: { value: this.fieldTexture },
      uSpawn: { value: spawnTex },
      uSpawnRes: { value: new THREE.Vector2(this._spawnRes, this._spawnRes) },
      uTime: { value: 0 },
      uSpeed: { value: 0.001 },
      uAspect: { value: this.aspect },
      uJitter: { value: 0.001 },
      uSpawnPeriod: { value: SPAWN_PERIOD },
      resolution: {
        value: new THREE.Vector2(this.textureSize, this.textureSize),
      },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: simulationFrag,
      uniforms: this.simUniforms,
    });

    const geo = new THREE.PlaneGeometry(2, 2);
    this._quad = new THREE.Mesh(geo, mat);
    this._scene = new THREE.Scene();
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene.add(this._quad);
  }

  compute(time) {
    this.simUniforms.uPositions.value = this.read.texture;
    this.simUniforms.uTime.value = time;

    this.renderer.setRenderTarget(this.write);
    this.renderer.render(this._scene, this._cam);
    this.renderer.setRenderTarget(null);

    // Swap
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this.simUniforms.uAspect.value = aspect;
  }

  get texture() {
    return this.read.texture;
  }
}
