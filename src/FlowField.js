import * as THREE from "three";
import { perlin2 } from "./noise2d.js";

// ─────────────────────────────────────────────────────────────────────────────
// FlowField — 12×12 그리드의 각 셀에 perlin 값을 줘서 방향 벡터필드를 만든다.
//   · texture: 시뮬레이션 셰이더가 샘플링하는 12×12 RG(방향) 텍스처
//   · buildArrows(): 같은 필드를 화살표로 보여주는 Three.js LineSegments
// 도메인은 정사각형 [-1,1] × [-1,1] 기준.
// ─────────────────────────────────────────────────────────────────────────────
export class FlowField {
  // noiseScale  : 작을수록 셀들이 noise 공간에서 가깝게 샘플링됨 → 필드가 매끄러움(저주파).
  // angleMul    : noise 값을 각도로 바꾸는 배율. 작을수록 이웃 셀 간 방향 변화가 완만함.
  //               (이전엔 scale=0.45·angleMul=2π라 이웃끼리 평균 91°씩 튀어 거칠어 보였음)
  // aspect : 오버레이를 그릴 도메인 가로 반폭. x∈[-aspect,aspect], y∈[-1,1].
  //           텍스처(grid×grid 단위벡터)는 정규화 UV로 샘플되므로 aspect와 무관.
  constructor(grid = 12, noiseScale = 0.2, angleMul = Math.PI, aspect = 1) {
    this.grid = grid;
    this.aspect = aspect;
    this.cells = []; // 화살표용: { i, j, vx, vy }

    const data = new Float32Array(grid * grid * 4);
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        // 셀마다 perlin 노이즈 값(≈[-1,1]) → 각도 → 단위 방향 벡터
        const n = perlin2(i * noiseScale, j * noiseScale);
        const angle = n * angleMul;
        const vx = Math.cos(angle);
        const vy = Math.sin(angle);

        const idx = (j * grid + i) * 4;
        data[idx + 0] = vx; // R = x 성분
        data[idx + 1] = vy; // G = y 성분
        data[idx + 2] = 1; // B = mask (폴백 모드는 도메인 전역이 유효 영역 → 1)
        data[idx + 3] = 1;

        this.cells.push({ i, j, vx, vy });
      }
    }

    // 텍스처 데이터 배열을 보관 → 편집 시 텍셀을 직접 갱신하고 re-upload
    this.data = data;

    // NearestFilter → 셀 경계에서 보간하지 않음 = 셀 안에서는 같은 방향(계단형 필드)
    this.texture = new THREE.DataTexture(
      data,
      grid,
      grid,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  // 도메인 좌표(x∈[-aspect,aspect], y∈[-1,1])가 속한 셀 인덱스 반환
  cellAt(x, y) {
    const i = Math.floor((x / this.aspect * 0.5 + 0.5) * this.grid);
    const j = Math.floor((y * 0.5 + 0.5) * this.grid);
    const clamp = (v) => Math.max(0, Math.min(this.grid - 1, v));
    return { i: clamp(i), j: clamp(j) };
  }

  // 셀 중심의 도메인 좌표 (가로는 aspect로 확장, 세로는 [-1,1])
  cellCenter(i, j) {
    const cellX = (2.0 * this.aspect) / this.grid;
    const cellY = 2.0 / this.grid;
    return { x: -this.aspect + (i + 0.5) * cellX, y: -1 + (j + 0.5) * cellY };
  }

  // 한 셀의 화살표 정점 18개(선분 3개 = 본체 + 화살촉 2)를 out[offset..]에 기록
  _writeArrow(c, out, offset) {
    // 길이는 세로 셀 기준(도메인 단위) — 도메인↔픽셀이 두 축 등방이라 각도가 실제 이동과 일치
    const len = (2.0 / this.grid) * 0.42; // 화살표 본체 길이
    const head = len * 0.35; // 화살촉 길이
    const { x: cx, y: cy } = this.cellCenter(c.i, c.j);
    const ex = cx + c.vx * len; // 화살표 끝
    const ey = cy + c.vy * len;
    const a = Math.atan2(c.vy, c.vx);
    const a1 = a + Math.PI * 0.82;
    const a2 = a - Math.PI * 0.82;
    const v = [
      cx, cy, 0, ex, ey, 0, // 본체
      ex, ey, 0, ex + Math.cos(a1) * head, ey + Math.sin(a1) * head, 0, // 화살촉
      ex, ey, 0, ex + Math.cos(a2) * head, ey + Math.sin(a2) * head, 0,
    ];
    for (let k = 0; k < 18; k++) out[offset + k] = v[k];
  }

  // 특정 셀의 방향을 (vx, vy) 방향으로 설정 → 텍스처 + 화살표를 실시간 갱신
  setCellDir(i, j, vx, vy) {
    if (i < 0 || j < 0 || i >= this.grid || j >= this.grid) return;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return; // 방향 없음 → 무시
    vx /= len;
    vy /= len;

    const k = j * this.grid + i;
    const c = this.cells[k];
    c.vx = vx;
    c.vy = vy;

    // (1) 시뮬레이션용 텍스처 텍셀 갱신
    this.data[k * 4 + 0] = vx;
    this.data[k * 4 + 1] = vy;
    this.texture.needsUpdate = true;

    // (2) 화살표 지오메트리 갱신
    if (this._arrowAttr) {
      this._writeArrow(c, this._arrowAttr.array, k * 18);
      this._arrowAttr.needsUpdate = true;
    }
  }

  // 화살표 시각화 — 각 셀 중심에서 방향 벡터로 뻗는 선 + 화살촉.
  // 좌표는 도메인 [-1,1]² 에 맞춰 배치된다.
  buildArrows(color = 0x44ff99) {
    const arr = new Float32Array(this.cells.length * 18);
    this.cells.forEach((c, k) => this._writeArrow(c, arr, k * 18));

    const geo = new THREE.BufferGeometry();
    this._arrowAttr = new THREE.BufferAttribute(arr, 3); // 편집 시 갱신용으로 보관
    geo.setAttribute("position", this._arrowAttr);
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
    );
  }

  // 셀 경계를 그리는 격자선 (선택적 시각화). 도메인 x∈[-aspect,aspect], y∈[-1,1].
  buildGrid(color = 0x224433) {
    const grid = this.grid;
    const a = this.aspect;
    const cellX = (2.0 * a) / grid;
    const cellY = 2.0 / grid;
    const pos = [];
    for (let k = 0; k <= grid; k++) {
      const x = -a + k * cellX;
      pos.push(x, -1, 0, x, 1, 0); // 세로선
      const y = -1 + k * cellY;
      pos.push(-a, y, 0, a, y, 0); // 가로선
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
    );
  }
}
