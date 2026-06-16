import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// 2D Perlin noise (Ken Perlin의 improved noise) — 고정 순열 테이블이라 매번 같은 필드
// ─────────────────────────────────────────────────────────────────────────────
const P = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140,
  36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234,
  75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237,
  149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48,
  27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105,
  92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73,
  209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86,
  164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38,
  147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189,
  28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101,
  155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
  178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12,
  191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
  181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254,
  138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215,
  61, 156, 180,
];
const PERM = new Uint8Array(512);
for (let i = 0; i < 512; i++) PERM[i] = P[i & 255];

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + t * (b - a);
function grad(hash, x, y) {
  switch (hash & 3) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    default:
      return -x - y;
  }
}

// 결과 범위 ≈ [-1, 1]
// DistrictField 등에서 행정동 중심 좌표의 placeholder 벡터를 산정할 때 재사용한다.
export function perlin2(x, y) {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
    v,
  );
}

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
  constructor(grid = 12, noiseScale = 0.2, angleMul = Math.PI) {
    this.grid = grid;
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

  // 도메인 좌표(x,y ∈ [-1,1])가 속한 셀 인덱스 반환
  cellAt(x, y) {
    const i = Math.floor((x * 0.5 + 0.5) * this.grid);
    const j = Math.floor((y * 0.5 + 0.5) * this.grid);
    const clamp = (v) => Math.max(0, Math.min(this.grid - 1, v));
    return { i: clamp(i), j: clamp(j) };
  }

  // 셀 중심의 도메인 좌표
  cellCenter(i, j) {
    const cell = 2.0 / this.grid;
    return { x: -1 + (i + 0.5) * cell, y: -1 + (j + 0.5) * cell };
  }

  // 한 셀의 화살표 정점 18개(선분 3개 = 본체 + 화살촉 2)를 out[offset..]에 기록
  _writeArrow(c, out, offset) {
    const cell = 2.0 / this.grid;
    const len = cell * 0.42; // 화살표 본체 길이
    const head = len * 0.35; // 화살촉 길이
    const cx = -1 + (c.i + 0.5) * cell;
    const cy = -1 + (c.j + 0.5) * cell;
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

  // 12×12 셀 경계를 그리는 격자선 (선택적 시각화)
  buildGrid(color = 0x224433) {
    const grid = this.grid;
    const cell = 2.0 / grid;
    const pos = [];
    for (let k = 0; k <= grid; k++) {
      const t = -1 + k * cell;
      pos.push(t, -1, 0, t, 1, 0); // 세로선
      pos.push(-1, t, 0, 1, t, 0); // 가로선
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
    );
  }
}
