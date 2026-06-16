import * as THREE from "three";
import { perlin2 } from "./FlowField.js";

// ─────────────────────────────────────────────────────────────────────────────
// DistrictField — 서울시 행정동 GeoJSON 경계를 벡터필드로 굽는다(rasterize).
//
//   핵심: 행정동은 비정형(불규칙) 다각형이지만, "어느 동에 속하는가" 판정을
//   매 프레임 셰이더에서 하지 않고 텍스처로 한 번 구워둔다. 그러면 런타임은
//   기존과 동일하게 "파티클 위치 → uField 텍스처 1회 샘플 → 그 동의 벡터"가 된다.
//
//   · texture     : 시뮬레이션 셰이더가 샘플링하는 RGBA Float 텍스처
//                   R=vx, G=vy, B=mask(동 내부 1 / 서울 밖 0), A=1. NearestFilter.
//   · spawnTexture: 서울 영역 안의 무작위 위치 목록(재생성용). RG=도메인 x,y.
//   · interior    : 서울 안 도메인 좌표 [x,y,...] (GPUCompute 초기 위치 시드용)
//   · buildBoundaries()/buildArrows(): 행정동 경계선/방향 화살표 오버레이
//
//   도메인은 위도 보정된 종횡비 aspect 로 x∈[-aspect,aspect], y∈[-1,1].
// ─────────────────────────────────────────────────────────────────────────────
export class DistrictField {
  // GeoJSON 을 비동기로 받아 필드를 만든다. fetch 실패는 호출 측에서 폴백 처리.
  static async load(url, opts = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GeoJSON load 실패: ${res.status} ${url}`);
    const geojson = await res.json();
    return new DistrictField(geojson, opts);
  }

  constructor(geojson, opts = {}) {
    const {
      fieldRes = 512, // 필드/래스터화 해상도 (클수록 경계가 또렷)
      spawnRes = 128, // 스폰 위치 텍스처 해상도 (128² = 16,384개 후보)
      placeholder = "random", // 동별 placeholder 벡터 방식: "random"(동마다 독립 무작위) | "perlin"(부드러운 노이즈)
      strengthFloor = 0.2, // 가장 약한 동의 속도 비율(0~1). 0이면 약한 동은 거의 멈춤.
      noiseScale = 3.0, // (perlin) 동 중심 좌표 → perlin 입력 배율 (클수록 이웃 동 방향차 큼)
      angleMul = Math.PI, // (perlin) perlin 값(≈[-1,1]) → 각도 배율
      noiseOffset = [10.5, 4.5], // (perlin) 샘플 위치 오프셋 (0,0 대칭 회피)
    } = opts;

    this.fieldRes = fieldRes;
    this.spawnRes = spawnRes;
    this._opts = { placeholder, strengthFloor, noiseScale, angleMul, noiseOffset };

    const features = (geojson.features || []).filter(
      (f) => f.geometry && f.geometry.coordinates,
    );

    // ── 1) 전체 bbox & 위도 보정 투영 함수 ──────────────────────────────────
    this._computeProjection(features);

    // ── 2) 동별 메타(중심 좌표 + 방향 dir + 원시 강도 mag) ─────────────────
    //   인덱스 1부터 부여(0 = 동 없음/서울 밖). 래스터화 색상에 인덱스를 인코딩.
    this.districts = features.map((f, k) => {
      const centroid = this._centroid(f);
      const { dir, mag } = this._districtVectorRaw(f, centroid);
      return { idx: k + 1, feature: f, centroid, dir, mag };
    });

    // 동별 강도를 최댓값으로 정규화 → [strengthFloor, 1] 로 매핑.
    //   실데이터의 단위/스케일과 무관하게 가장 센 동이 1(=전역 uSpeed)이 되도록.
    //   최종 벡터 vx/vy = 방향(단위) × strength (길이가 곧 상대 속도).
    const maxMag = Math.max(1e-9, ...this.districts.map((d) => d.mag));
    const floor = this._opts.strengthFloor;
    for (const d of this.districts) {
      d.strength = floor + (1 - floor) * (d.mag / maxMag);
      d.vx = d.dir[0] * d.strength;
      d.vy = d.dir[1] * d.strength;
    }

    // ── 3) 폴리곤 래스터화 → 필드 텍스처 + 마스크 + 내부 위치 목록 ──────────
    this._rasterize();

    // ── 4) 서울 안 무작위 스폰 위치 텍스처 ─────────────────────────────────
    this._buildSpawnTexture();
  }

  // ── 좌표 투영 ───────────────────────────────────────────────────────────────
  _computeProjection(features) {
    let minLon = Infinity,
      minLat = Infinity,
      maxLon = -Infinity,
      maxLat = -Infinity;
    for (const f of features) {
      this._eachRing(f, (ring) => {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      });
    }

    const meanLat = (minLat + maxLat) / 2;
    const lonSpan = maxLon - minLon || 1e-9;
    const latSpan = maxLat - minLat || 1e-9;
    // 좌표계 감지: 값이 위경도 범위를 벗어나면 미터 단위 투영좌표계(예: EPSG:5179).
    //   · 위경도 → 경도 1도는 위도 1도보다 짧으므로 cos(lat) 보정
    //   · 미터 좌표 → 가로/세로 스케일이 같으므로 보정 없이 그대로
    const isLonLat = Math.abs(maxLon) <= 180 && Math.abs(maxLat) <= 90;
    const lonScale = isLonLat ? Math.cos((meanLat * Math.PI) / 180) : 1;
    const aspect = ((lonSpan * lonScale) / latSpan) || 1;
    this.aspect = aspect;
    this.bbox = { minLon, minLat, maxLon, maxLat };

    // lon/lat → 도메인 좌표 (x∈[-aspect,aspect], y∈[-1,1])
    this.project = (lon, lat) => ({
      x: (((lon - minLon) / lonSpan) * 2 - 1) * aspect,
      y: ((lat - minLat) / latSpan) * 2 - 1,
    });
  }

  // feature 의 모든 ring(외곽 + 구멍)을 콜백으로 순회. Polygon/MultiPolygon 모두 처리.
  _eachRing(feature, cb) {
    const g = feature.geometry;
    if (g.type === "Polygon") {
      for (const ring of g.coordinates) cb(ring);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) for (const ring of poly) cb(ring);
    }
  }

  // feature 의 모든 폴리곤(각각 ring 배열)을 콜백으로 순회.
  _eachPolygon(feature, cb) {
    const g = feature.geometry;
    if (g.type === "Polygon") cb(g.coordinates);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) cb(poly);
  }

  // 외곽 정점들의 단순 평균(도메인 좌표) — placeholder 벡터 샘플 위치로 충분
  _centroid(feature) {
    let sx = 0,
      sy = 0,
      n = 0;
    this._eachPolygon(feature, (poly) => {
      for (const [lon, lat] of poly[0]) {
        const p = this.project(lon, lat);
        sx += p.x;
        sy += p.y;
        n++;
      }
    });
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  }

  // 동 → { dir:[ux,uy] 단위방향, mag:상대강도(>=0) }. 실데이터 우선, 없으면 placeholder.
  //   ⇒ 추후 Python 이 properties.vx/vy(또는 angle[+strength])를 채우면 자동 교체됨.
  _districtVectorRaw(feature, centroid) {
    const p = feature.properties || {};
    const seed =
      p.ADM_CD != null ? String(p.ADM_CD) : `${centroid.x},${centroid.y}`;

    // 실데이터: vx/vy 의 길이가 곧 강도
    if (typeof p.vx === "number" && typeof p.vy === "number") {
      const L = Math.hypot(p.vx, p.vy);
      if (L < 1e-9) return { dir: [1, 0], mag: 0 };
      return { dir: [p.vx / L, p.vy / L], mag: L };
    }
    // 실데이터: angle(방향) + strength/mag(강도, 없으면 1)
    if (typeof p.angle === "number") {
      const mag =
        typeof p.strength === "number"
          ? p.strength
          : typeof p.mag === "number"
            ? p.mag
            : 1;
      return { dir: [Math.cos(p.angle), Math.sin(p.angle)], mag };
    }

    // placeholder
    if (this._opts.placeholder === "perlin") {
      // 부드러운 노이즈 — 이웃 동끼리 방향이 비슷해 큰 흐름으로 정렬됨
      const { noiseScale, angleMul, noiseOffset } = this._opts;
      const n = perlin2(
        centroid.x * noiseScale + noiseOffset[0],
        centroid.y * noiseScale + noiseOffset[1],
      );
      const a = n * angleMul;
      return { dir: [Math.cos(a), Math.sin(a)], mag: 1 };
    }
    // 동마다 독립적인 무작위 방향 + 무작위 강도 (동 ID 해시 → 재실행해도 동일)
    const a = this._hash01(seed) * Math.PI * 2;
    const mag = this._hash01(seed + "|s"); // 0~1 무작위 강도
    return { dir: [Math.cos(a), Math.sin(a)], mag };
  }

  // 문자열 시드 → [0, 1) 안정적 의사난수 (FNV-1a 해시)
  _hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  // 도메인 좌표 → 래스터 캔버스 픽셀(좌상단 원점, y-down)
  _toPixel(x, y) {
    const R = this.fieldRes;
    return {
      px: ((x / this.aspect) * 0.5 + 0.5) * R,
      py: (0.5 - y * 0.5) * R, // y=+1 → 0(위), y=-1 → R(아래)
    };
  }

  // ── 폴리곤 래스터화 ─────────────────────────────────────────────────────────
  _rasterize() {
    const R = this.fieldRes;
    const canvas = document.createElement("canvas");
    canvas.width = R;
    canvas.height = R;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // 배경(서울 밖) = 검정 = 인덱스 0
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, R, R);

    // 각 동을 "인덱스 색"으로 채움: R=idx&255, G=(idx>>8)&255
    for (const d of this.districts) {
      ctx.fillStyle = `rgb(${d.idx & 255}, ${(d.idx >> 8) & 255}, 0)`;
      ctx.beginPath();
      this._eachPolygon(d.feature, (poly) => {
        for (const ring of poly) {
          ring.forEach(([lon, lat], i) => {
            const p = this.project(lon, lat);
            const { px, py } = this._toPixel(p.x, p.y);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.closePath();
        }
      });
      // evenodd: MultiPolygon 의 구멍(내부 ring)을 제외하고 채움
      ctx.fill("evenodd");
    }

    const img = ctx.getImageData(0, 0, R, R).data;

    // 필드 텍스처(Float) + 내부 위치 목록 생성.
    // DataTexture 는 행 0 = 아래(v=0) → 캔버스(위가 0)와 상하 반전해 기록.
    const data = new Float32Array(R * R * 4);
    const interior = [];
    const cell = 2.0 / R;
    for (let j = 0; j < R; j++) {
      const srcRow = R - 1 - j; // 상하 반전
      for (let i = 0; i < R; i++) {
        const src = (srcRow * R + i) * 4;
        const idx = img[src] + (img[src + 1] << 8);
        const dst = (j * R + i) * 4;
        const d = idx > 0 ? this.districts[idx - 1] : undefined;
        if (d) {
          data[dst + 0] = d.vx;
          data[dst + 1] = d.vy;
          data[dst + 2] = 1.0; // mask = 동 내부
          data[dst + 3] = 1.0;
          // 텍셀 중심의 도메인 좌표를 내부 위치로 수집
          const x = (-1 + (i + 0.5) * cell) * this.aspect;
          const y = -1 + (j + 0.5) * cell;
          interior.push(x, y);
        } // else: 0,0,0,0 (서울 밖)
      }
    }

    this.data = data;
    this.interior = interior; // Float [x,y, x,y, ...]
    this.texture = new THREE.DataTexture(
      data,
      R,
      R,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  // 도메인 안의 무작위 위치 하나(서울 내부에서 균등). 없으면 원점.
  randomInteriorPoint() {
    const n = this.interior.length / 2;
    if (n === 0) return { x: 0, y: 0 };
    const k = Math.floor(Math.random() * n) * 2;
    return { x: this.interior[k], y: this.interior[k + 1] };
  }

  // ── 스폰 위치 텍스처 ────────────────────────────────────────────────────────
  _buildSpawnTexture() {
    const S = this.spawnRes;
    const data = new Float32Array(S * S * 4);
    for (let k = 0; k < S * S; k++) {
      const p = this.randomInteriorPoint();
      data[k * 4 + 0] = p.x;
      data[k * 4 + 1] = p.y;
      data[k * 4 + 2] = 0.0;
      data[k * 4 + 3] = 1.0;
    }
    this.spawnTexture = new THREE.DataTexture(
      data,
      S,
      S,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.spawnTexture.minFilter = THREE.NearestFilter;
    this.spawnTexture.magFilter = THREE.NearestFilter;
    this.spawnTexture.needsUpdate = true;
  }

  // ── 오버레이: 행정동 경계선 ─────────────────────────────────────────────────
  buildBoundaries(color = 0x335577) {
    const pos = [];
    for (const d of this.districts) {
      this._eachPolygon(d.feature, (poly) => {
        for (const ring of poly) {
          for (let i = 0; i < ring.length - 1; i++) {
            const a = this.project(ring[i][0], ring[i][1]);
            const b = this.project(ring[i + 1][0], ring[i + 1][1]);
            pos.push(a.x, a.y, 0, b.x, b.y, 0); // 선분
          }
        }
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
    );
  }

  // ── 오버레이: 동 중심에서 벡터 방향 화살표 ─────────────────────────────────
  buildArrows(color = 0x44ff99) {
    const len = 0.025; // 화살표 본체 길이(도메인 단위)
    const head = len * 0.4;
    const pos = [];
    for (const d of this.districts) {
      const cx = d.centroid.x,
        cy = d.centroid.y;
      const ex = cx + d.vx * len,
        ey = cy + d.vy * len;
      const a = Math.atan2(d.vy, d.vx);
      const a1 = a + Math.PI * 0.82,
        a2 = a - Math.PI * 0.82;
      pos.push(cx, cy, 0, ex, ey, 0);
      pos.push(ex, ey, 0, ex + Math.cos(a1) * head, ey + Math.sin(a1) * head, 0);
      pos.push(ex, ey, 0, ex + Math.cos(a2) * head, ey + Math.sin(a2) * head, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
    );
  }
}
