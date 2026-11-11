// ニュージーランド固有の設定（座標系・LINZタイル・タイムゾーン）
import proj4 from 'proj4';

proj4.defs(
  'EPSG:2193',
  '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
);

export const toNZTM = (lng: number, lat: number): [number, number] =>
  proj4('EPSG:4326', 'EPSG:2193', [lng, lat]) as [number, number];
export const toLngLat = (x: number, y: number): [number, number] =>
  proj4('EPSG:2193', 'EPSG:4326', [x, y]) as [number, number];

// Westfield Albany（中心）
export const CENTER: [number, number] = [174.7066, -36.7283];
export const RADIUS_M = 10000;

// LINZ 全国 1m DSM / DEM（Topo50 1:50k シート単位の Cloud Optimised GeoTIFF）
// https://github.com/linz/elevation  s3://nz-elevation/new-zealand/new-zealand/
const BASE = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand';
export const dsmUrl = (sheet: string) => `${BASE}/dsm_1m/2193/${sheet}.tiff`;
export const demUrl = (sheet: string) => `${BASE}/dem_1m/2193/${sheet}.tiff`;

// シート原点（linz/topo-imagery tile_index.py と同じ計算式）
const SHEET_W = 24000;
const SHEET_H = 36000;
const ORIGIN_LEFT = 988000;
const ORIGIN_TOP = 6234000;
const ROWS = ['AS', 'AT', 'AU', 'AV', 'AW', 'AX', 'AY', 'AZ', 'BA', 'BB', 'BC'];
// DSM と DEM の両方が公開されているシート（STACコレクションで確認済み）
const AVAILABLE = new Set(['AZ31', 'AZ32', 'BA30', 'BA31', 'BA32', 'BB31', 'BB32']);

export interface Sheet {
  code: string;
  bbox: [number, number, number, number]; // minx, miny, maxx, maxy (NZTM)
}

export function sheetsFor(b: [number, number, number, number]): Sheet[] {
  const out: Sheet[] = [];
  const c0 = Math.floor((b[0] - ORIGIN_LEFT) / SHEET_W);
  const c1 = Math.floor((b[2] - 0.001 - ORIGIN_LEFT) / SHEET_W);
  const r0 = Math.floor((ORIGIN_TOP - b[3]) / SHEET_H);
  const r1 = Math.floor((ORIGIN_TOP - b[1] - 0.001) / SHEET_H);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const code = `${ROWS[r]}${String(c).padStart(2, '0')}`;
      if (!AVAILABLE.has(code)) continue;
      const minx = ORIGIN_LEFT + c * SHEET_W;
      const maxy = ORIGIN_TOP - r * SHEET_H;
      out.push({ code, bbox: [minx, maxy - SHEET_H, minx + SHEET_W, maxy] });
    }
  }
  return out;
}

// ---- 時刻（常にオークランド時間で扱う。夏時間も自動） ----
const TZ = 'Pacific/Auckland';
const fmt = new Intl.DateTimeFormat('en-NZ', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function nzParts(d: Date) {
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(d)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

function offsetMs(d: Date) {
  const p = nzParts(d);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}

/** オークランドの日付 + 分（0〜1439）→ Date */
export function nzToDate(dateStr: string, minutes: number): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const local = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = local - offsetMs(new Date(local));
  t = local - offsetMs(new Date(t));
  return new Date(t);
}

export function nowNZ() {
  const p = nzParts(new Date());
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { date, minutes: p.hour * 60 + p.minute };
}

export const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
