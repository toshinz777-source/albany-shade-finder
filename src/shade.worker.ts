// 高さデータの取得と影の計算（メイン画面を止めないよう Web Worker で実行）
import { fromUrl, GeoTIFF } from 'geotiff';
import { sheetsFor, dsmUrl, demUrl } from './nz';

type BBox = [number, number, number, number];
type Ring = [number, number][]; // NZTM

interface Region {
  id: number;
  bbox: BBox; // 読み込み範囲（パディング込み）
  inner: [number, number, number, number]; // 表示する範囲（ピクセル: x0,y0,x1,y1）
  res: number;
  W: number;
  H: number;
  dsm: Float32Array;
  dem: Float32Array;
  valid: Uint8Array;
  building: Uint8Array;
  maxH: number;
  lots: { id: string; pixels: Int32Array }[];
}

const NODATA = -9999;
const OBJ_MIN = 2.0; // 地面から2m以上を「障害物（建物・樹木）」とみなす（車・柵は除外）
const CAR_H = 1.0; // 車の中ほどの高さで日陰を判定

// スマホ回線で一時的に切れても大丈夫なよう、通信は自動で再試行する
const realFetch = self.fetch.bind(self);
(self as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  let lastErr: unknown;
  for (let a = 0; a < 4; a++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 40000);
    try {
      const r = await realFetch(input, { ...init, signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (r.status >= 500) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      await new Promise((res) => setTimeout(res, 700 * 2 ** a));
    }
  }
  throw lastErr;
};

const tiffCache = new Map<string, Promise<GeoTIFF>>();
function openTiff(url: string) {
  let p = tiffCache.get(url);
  if (!p) {
    p = fromUrl(url, { allowFullFile: false });
    p.catch(() => tiffCache.delete(url));
    tiffCache.set(url, p);
  }
  return p;
}

async function mosaic(urlFn: (s: string) => string, bbox: BBox, res: number, W: number, H: number) {
  const out = new Float32Array(W * H).fill(NODATA);
  const sheets = sheetsFor(bbox);
  await Promise.all(
    sheets.map(async (s) => {
      const ix: BBox = [
        Math.max(bbox[0], s.bbox[0]),
        Math.max(bbox[1], s.bbox[1]),
        Math.min(bbox[2], s.bbox[2]),
        Math.min(bbox[3], s.bbox[3]),
      ];
      const w = Math.round((ix[2] - ix[0]) / res);
      const h = Math.round((ix[3] - ix[1]) / res);
      if (w <= 0 || h <= 0) return;
      const tiff = await openTiff(urlFn(s.code));
      const data = (await tiff.readRasters({
        bbox: ix,
        width: w,
        height: h,
        fillValue: NODATA,
        samples: [0],
        interleave: true,
      })) as unknown as Float32Array;
      const ox = Math.round((ix[0] - bbox[0]) / res);
      const oy = Math.round((bbox[3] - ix[3]) / res);
      for (let r = 0; r < h; r++) out.set(data.subarray(r * w, r * w + w), (oy + r) * W + ox);
    })
  );
  return out;
}

// 偶奇規則のスキャンライン塗りつぶし（ピクセル座標の多角形）
function fillPolygon(rings: [number, number][][], W: number, H: number, cb: (i: number) => void) {
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xa, ya] = r[i], [xb, yb] = r[j];
        if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) cb(y * W + x);
    }
  }
}

let region: Region | null = null;
let latestLoad = 0;
const pendingLots = new Map<number, { id: string; rings: Ring[] }[]>();

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const { id, bbox, res, pad } = m as { id: number; bbox: BBox; res: number; pad: number };
      latestLoad = id;
      const W = Math.round((bbox[2] - bbox[0]) / res);
      const H = Math.round((bbox[3] - bbox[1]) / res);
      if (sheetsFor(bbox).length === 0) {
        postMessage({ type: 'loaded', id, W, H, nodata: 1, sheets: [] });
        region = null;
        return;
      }
      const [dsm, dem] = await Promise.all([mosaic(dsmUrl, bbox, res, W, H), mosaic(demUrl, bbox, res, W, H)]);
      if (id !== latestLoad) return; // より新しい要求が来ている
      const valid = new Uint8Array(W * H);
      let maxH = -Infinity, nValid = 0;
      for (let i = 0; i < W * H; i++) {
        const a = dsm[i], b = dem[i];
        if (a > -1000 && b > -1000 && Number.isFinite(a) && Number.isFinite(b)) {
          valid[i] = 1;
          nValid++;
          if (a > maxH) maxH = a;
        }
      }
      const building = new Uint8Array(W * H);
      const toPx = (r: Ring) => r.map(([x, y]) => [(x - bbox[0]) / res, (bbox[3] - y) / res] as [number, number]);
      for (const poly of m.buildings as Ring[][]) fillPolygon(poly.map(toPx), W, H, (i) => (building[i] = 1));
      const p = Math.round(pad / res);
      region = { id, bbox, res, W, H, dsm, dem, valid, building, maxH, lots: [], inner: [p, p, W - p, H - p] };
      setLots(pendingLots.get(id) ?? []);
      pendingLots.clear();
      postMessage({ type: 'loaded', id, W, H, nodata: 1 - nValid / (W * H) });
    } else if (m.type === 'lots') {
      if (region && region.id === m.id) setLots(m.lots);
      else if (m.id === latestLoad) pendingLots.set(m.id, m.lots);
    } else if (m.type === 'shade') {
      if (!region || region.id !== m.id) return;
      const r = computeShade(region, m.azimuth, m.altitude, m.seq);
      postMessage(r, [r.rgba.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
  }
};

function setLots(lots: { id: string; rings: Ring[] }[]) {
  if (!region) return;
  const { bbox, res, W, H } = region;
  const toPx = (r: Ring) => r.map(([x, y]) => [(x - bbox[0]) / res, (bbox[3] - y) / res] as [number, number]);
  region.lots = lots.map((l) => {
    const px: number[] = [];
    fillPolygon(l.rings.map(toPx), W, H, (i) => px.push(i));
    return { id: l.id, pixels: Int32Array.from(px) };
  });
}

// 分類コード
const SUN = 0, SHADE_SOLID = 1, SHADE_TREE = 2, CANOPY = 3, ROOF = 4, NODATA_C = 5;

function computeShade(R: Region, azimuth: number, altitude: number, seq: number) {
  const { W, H, dsm, dem, valid, building, res, maxH } = R;
  const [x0, y0, x1, y1] = R.inner;
  const w = x1 - x0, h = y1 - y0;
  const cls = new Uint8Array(w * h);
  // SunCalc の方位角: 0=南, 正=西回り。太陽へ向かう方向（グリッドは下が南）
  const dx = -Math.sin(azimuth);
  const dy = Math.cos(azimuth);
  const night = altitude <= 0;
  const rise = res * Math.tan(Math.max(altitude, 0.0001));
  const height = (i: number) => (dsm[i] - dem[i] >= OBJ_MIN ? dsm[i] : dem[i]);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const o = (y - y0) * w + (x - x0);
      if (!valid[i]) { cls[o] = NODATA_C; continue; }
      if (building[i] && dsm[i] - dem[i] >= OBJ_MIN) { cls[o] = ROOF; continue; }
      if (dsm[i] - dem[i] >= OBJ_MIN + 0.5) { cls[o] = CANOPY; continue; }
      if (night) { cls[o] = SHADE_SOLID; continue; }
      const h0 = dem[i] + CAR_H;
      const steps = Math.min(Math.ceil((maxH - h0) / rise), 2000);
      let c = SUN;
      let fx = x + 0.5, fy = y + 0.5;
      for (let k = 1; k <= steps; k++) {
        fx += dx; fy += dy;
        const sx = fx | 0, sy = fy | 0;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) break;
        const j = sy * W + sx;
        if (!valid[j]) continue;
        if (height(j) > h0 + k * rise) {
          c = building[j] || dsm[j] - dem[j] < OBJ_MIN ? SHADE_SOLID : SHADE_TREE;
          if (c === SHADE_SOLID) break; // 建物・地形の影が確定したら終了。樹木の場合はさらに先の建物を探す
        }
      }
      cls[o] = c;
    }
  }

  // 色付け（RGBA）
  const rgba = new Uint8ClampedArray(w * h * 4);
  const COLORS: Record<number, [number, number, number, number]> = {
    [SUN]: [0, 0, 0, 0],
    [SHADE_SOLID]: [20, 70, 230, 140],
    [SHADE_TREE]: [70, 170, 255, 110],
    [CANOPY]: [0, 150, 110, 95],
    [ROOF]: [0, 0, 0, 0],
    [NODATA_C]: [120, 120, 120, 120],
  };
  let nodataCount = 0;
  for (let o = 0; o < cls.length; o++) {
    const c = COLORS[cls[o]];
    if (cls[o] === NODATA_C) {
      nodataCount++;
      // 斜線模様で「データなし」を区別
      const xx = o % w, yy = (o / w) | 0;
      if (((xx + yy) >> 2) % 2) { rgba[o * 4 + 3] = 40; rgba[o * 4] = rgba[o * 4 + 1] = rgba[o * 4 + 2] = 90; continue; }
    }
    rgba[o * 4] = c[0]; rgba[o * 4 + 1] = c[1]; rgba[o * 4 + 2] = c[2]; rgba[o * 4 + 3] = c[3];
  }

  // 駐車場ごとの日陰率
  const lots = R.lots.map((l) => {
    let shade = 0, tree = 0, sun = 0, nod = 0;
    for (const i of l.pixels) {
      const x = i % W, y = (i / W) | 0;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const c = cls[(y - y0) * w + (x - x0)];
      if (c === SHADE_SOLID) shade++;
      else if (c === SHADE_TREE || c === CANOPY) tree++;
      else if (c === SUN) sun++;
      else if (c === NODATA_C) nod++;
    }
    const tot = shade + tree + sun;
    return { id: l.id, area: tot * res * res, solid: tot ? shade / tot : 0, tree: tot ? tree / tot : 0, nodata: nod };
  });

  const xmin = R.bbox[0] + x0 * res, ymax = R.bbox[3] - y0 * res;
  return {
    type: 'shade', id: R.id, seq, w, h, rgba,
    bbox: [xmin, ymax - h * res, xmin + w * res, ymax],
    nodata: nodataCount / (w * h), lots, night,
  };
}
