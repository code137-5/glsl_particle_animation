import * as THREE from "three";
import simulationFrag from "./shaders/simulation.glsl";

const VERT = /* glsl */ `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

// 파티클 수명(프레임 단위). 이 시간이 지나면 화면 안 랜덤 위치로 재생성됨.
const LIFESPAN = 1500;

export class GPUCompute {
  constructor(renderer, textureSize, aspect = 1, fieldTexture = null) {
    this.renderer = renderer;
    this.textureSize = textureSize;
    this.count = textureSize * textureSize;
    this.aspect = aspect;
    this.fieldTexture = fieldTexture;

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
    for (let i = 0; i < size * size; i++) {
      data[i * 4 + 0] = (Math.random() * 2 - 1) * this.aspect; // x ∈ [-aspect, aspect]
      data[i * 4 + 1] = Math.random() * 2 - 1; // y ∈ [-1, 1]
      data[i * 4 + 2] = 0.0; // z = 0 (2D 평면)
      data[i * 4 + 3] = Math.random() * LIFESPAN; // 초기 나이를 무작위로 분산 → 재생성 타이밍 분산
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

  _initQuad() {
    this.simUniforms = {
      uPositions: { value: this.read.texture },
      uField: { value: this.fieldTexture },
      uTime: { value: 0 },
      uSpeed: { value: 0.003 },
      uAspect: { value: this.aspect },
      uJitter: { value: 0.001 },
      uLifespan: { value: LIFESPAN },
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
