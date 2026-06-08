import * as THREE from 'three'
import simulationFrag from './shaders/simulation.glsl'

const VERT = /* glsl */`
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`

export class GPUCompute {
  constructor(renderer, textureSize) {
    this.renderer = renderer
    this.textureSize = textureSize
    this.count = textureSize * textureSize

    const rtOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      depthBuffer: false,
    }
    this.read  = new THREE.WebGLRenderTarget(textureSize, textureSize, rtOptions)
    this.write = new THREE.WebGLRenderTarget(textureSize, textureSize, rtOptions)

    this._initPositions()
    this._initQuad()
  }

  _initPositions() {
    const size = this.textureSize
    const data = new Float32Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      data[i * 4 + 0] = (Math.random() * 2 - 1)
      data[i * 4 + 1] = (Math.random() * 2 - 1)
      data[i * 4 + 2] = (Math.random() * 2 - 1)
      data[i * 4 + 3] = 1.0
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType)
    tex.needsUpdate = true

    // 패스스루 셰이더로 float 데이터를 손상 없이 렌더 타겟에 복사
    const passMat = new THREE.ShaderMaterial({
      vertexShader: `void main() { gl_Position = vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uTex;
        uniform vec2 resolution;
        void main() {
          gl_FragColor = texture2D(uTex, gl_FragCoord.xy / resolution);
        }
      `,
      uniforms: {
        uTex: { value: tex },
        resolution: { value: new THREE.Vector2(size, size) },
      },
    })

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), passMat)
    const scene = new THREE.Scene()
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    scene.add(quad)
    this.renderer.setRenderTarget(this.read)
    this.renderer.render(scene, cam)
    this.renderer.setRenderTarget(null)
    passMat.dispose()
    tex.dispose()
  }

  _initQuad() {
    this.simUniforms = {
      uPositions:  { value: this.read.texture },
      uTime:       { value: 0 },
      uSpeed:      { value: 0.01 },
      uNoiseScale: { value: 1.5 },
      resolution:  { value: new THREE.Vector2(this.textureSize, this.textureSize) },
    }

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: simulationFrag,
      uniforms:       this.simUniforms,
    })

    const geo = new THREE.PlaneGeometry(2, 2)
    this._quad  = new THREE.Mesh(geo, mat)
    this._scene = new THREE.Scene()
    this._cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._scene.add(this._quad)
  }

  compute(time) {
    this.simUniforms.uPositions.value = this.read.texture
    this.simUniforms.uTime.value = time

    this.renderer.setRenderTarget(this.write)
    this.renderer.render(this._scene, this._cam)
    this.renderer.setRenderTarget(null)

    // Swap
    const tmp = this.read
    this.read  = this.write
    this.write = tmp
  }

  get texture() {
    return this.read.texture
  }
}
