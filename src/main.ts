import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, GeoJSONSource, ImageSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './style.css';
import * as SunCalc from 'suncalc';
import { CENTER, RADIUS_M, toNZTM, toLngLat, nzToDate, nowNZ, fmtMin, sheetsFor } from './nz';

type BBox = [number, number, number, number];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const dateEl = $<HTMLInputElement>('date');
const timeEl = $<HTMLInputElement>('time');
const timeLabel = $('timeLabel');
const sunEl = $('sun');

function setStatus(text: string, kind: '' | 'warn' | 'err' = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

const MIN_ZOOM_SHADE = 15;
const PAD_M = 160; // 画面外から伸びてくる影のための余白
const MAX_PIXELS = 3_000_000;
const [CX, CY] = toNZTM(...CENTER);

// ---------- 地図 ----------
maplibregl.setWorkerUrl(new URL(maplibreWorkerUrl, location.href).href);
const map: MLMap = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: CENTER,
  zoom: 16.3,
  minZoom: 11,
  maxZoom: 19.5,
  maxBounds: [
    [174.52, -36.88],
    [174.9, -36.57],
  ],
  pitchWithRotate: false,
  dragRotate: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showAccuracyCircle: true,
  }),
  'bottom-right'
);
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

function circlePolygon() {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(toLngLat(CX + RADIUS_M * Math.cos(a), CY + RADIUS_M * Math.sin(a)));
  }
  return pts;
}

const EMPTY_IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const TINY: [[number, number], [number, number], [number, number], [number, number]] = [
  [CENTER[0], CENTER[1] + 1e-5],
  [CENTER[0] + 1e-5, CENTER[1] + 1e-5],
  [CENTER[0] + 1e-5, CENTER[1]],
  [CENTER[0], CENTER[1]],
];

map.on('load', () => {
  const layers = map.getStyle().layers ?? [];
  // 立体の建物は影の表示を隠すので平面表示にする
  for (const l of layers) if (l.type === 'fill-extrusion') map.removeLayer(l.id);
  const firstSymbol = layers.find((l) => l.type === 'symbol' && map.getLayer(l.id))?.id;

  map.addSource('shade', {
    type: 'image',
    url: EMPTY_IMG,
    coordinates: TINY,
  });
  map.addLayer(
    { id: 'shade', type: 'raster', source: 'shade', paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity': 1 } },
    firstSymbol
  );

  map.addSource('lots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer(
    {
      id: 'lots-line',
      type: 'line',
      source: 'lots',
      paint: { 'line-color': '#ff8a00', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1, 18, 2.5], 'line-dasharray': [2, 1] },
    },
    firstSymbol
  );
  map.addLayer({
    id: 'lots-label',
    type: 'symbol',
    source: 'lots',
    minzoom: 16,
    layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Noto Sans Bold'], 'symbol-placement': 'point' },
    paint: { 'text-color': '#7a3d00', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });

  map.addSource('area', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: circlePolygon() } },
  });
  map.addLayer({ id: 'area', type: 'line', source: 'area', paint: { 'line-color': '#1546e6', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });

  map.on('click', 'lots-line', (e) => openLots());
  scheduleRegion();
});
map.on('moveend', () => scheduleRegion());
map.on('error', (e) => console.warn(e.error));

// ---------- 時刻 ----------
function initTime() {
  const n = nowNZ();
  dateEl.value = n.date;
  timeEl.value = String(Math.round(n.minutes / 5) * 5);
}
initTime();

function currentDate() {
  return nzToDate(dateEl.value, Number(timeEl.value));
}

const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
function sunInfo() {
  const d = currentDate();
  const p = SunCalc.getPosition(d, CENTER[1], CENTER[0]);
  const t = SunCalc.getTimes(d, CENTER[1], CENTER[0]);
  // SunCalc 2.x は度単位・方位は北から時計回り
  const azN = ((p.azimuth % 360) + 360) % 360;
  return { p, t, azN, alt: p.altitude };
}

function updateTimeUI() {
  timeLabel.textContent = fmtMin(Number(timeEl.value));
  const { t, azN, alt } = sunInfo();
  const f = (d: Date | null) => (!d || isNaN(d.getTime()) ? '--' : d.toLocaleTimeString('ja-JP', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit' }));
  sunEl.innerHTML =
    alt > 0
      ? `太陽 高さ${alt.toFixed(0)}° ${DIRS[Math.round(azN / 45) % 8]}<br>日の出${f(t.sunrise)} 日の入${f(t.sunset)}`
      : `🌙 日没中<br>日の出${f(t.sunrise)} 日の入${f(t.sunset)}`;
}

timeEl.addEventListener('input', () => { updateTimeUI(); requestShade(); });
dateEl.addEventListener('change', () => { updateTimeUI(); requestShade(); });
$('btnNow').addEventListener('click', () => { initTime(); updateTimeUI(); requestShade(); });
$('minus').addEventListener('click', () => { timeEl.value = String(Math.max(0, Number(timeEl.value) - 15)); updateTimeUI(); requestShade(); });
$('plus').addEventListener('click', () => { timeEl.value = String(Math.min(1435, Number(timeEl.value) + 15)); updateTimeUI(); requestShade(); });
updateTimeUI();

// ---------- 計算ワーカー ----------
const worker = new Worker(new URL('./shade.worker.ts', import.meta.url), { type: 'module' });

interface RegionState { id: number; bbox: BBox; innerBox: BBox; res: number; loaded: boolean }
let region: RegionState | null = null;
let regionSeq = 0;
let shadeSeq = 0;
let shadeBusy = false;
let shadePending = false;
let lotFeatures: GeoJSON.Feature[] = [];
let lastLots: LotStat[] = [];
interface LotStat { id: string; area: number; solid: number; tree: number; nodata: number }

let regionTimer = 0;
function scheduleRegion() {
  clearTimeout(regionTimer);
  regionTimer = window.setTimeout(updateRegion, 350);
}

function viewBoxNZTM(): BBox {
  const b = map.getBounds();
  const pts = [b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()].map((p) => toNZTM(p.lng, p.lat));
  return [
    Math.min(...pts.map((p) => p[0])),
    Math.min(...pts.map((p) => p[1])),
    Math.max(...pts.map((p) => p[0])),
    Math.max(...pts.map((p) => p[1])),
  ];
}

function updateRegion() {
  if (!map.isStyleLoaded()) return;
  const z = map.getZoom();
  if (z < MIN_ZOOM_SHADE) {
    hideShade();
    setStatus(`ズーム${MIN_ZOOM_SHADE}以上に拡大すると、その範囲の日陰を計算します（スマホを軽く保つため）。`);
    return;
  }
  const v = viewBoxNZTM();
  const vc = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2];
  if (Math.hypot(vc[0] - CX, vc[1] - CY) > RADIUS_M + 500) {
    hideShade();
    setStatus('対象エリア（Westfield Albanyから半径10km）の外です。点線の円の中へ戻ってください。', 'warn');
    return;
  }
  // すでに読み込んだ範囲に収まっていれば再読み込みしない
  if (region && v[0] >= region.innerBox[0] && v[1] >= region.innerBox[1] && v[2] <= region.innerBox[2] && v[3] <= region.innerBox[3]) {
    const wantRes = z >= 16.3 ? 1 : 2;
    if (region.res <= wantRes) return;
  }
  // 表示範囲を少し広げ、解像度を決める
  const ex = (v[2] - v[0]) * 0.15, ey = (v[3] - v[1]) * 0.15;
  let res = z >= 16.3 ? 1 : 2;
  let inner: BBox = [v[0] - ex, v[1] - ey, v[2] + ex, v[3] + ey];
  const px = () => ((inner[2] - inner[0] + 2 * PAD_M) * (inner[3] - inner[1] + 2 * PAD_M)) / (res * res);
  while (px() > MAX_PIXELS && res < 4) res *= 2;
  if (px() > MAX_PIXELS) {
    // 大きすぎる場合は中心部だけ
    const s = Math.sqrt(MAX_PIXELS / px());
    const cx = (inner[0] + inner[2]) / 2, cy = (inner[1] + inner[3]) / 2;
    const hw = ((inner[2] - inner[0]) * s) / 2, hh = ((inner[3] - inner[1]) * s) / 2;
    inner = [cx - hw, cy - hh, cx + hw, cy + hh];
  }
  const snap = (n: number, f: (x: number) => number) => f(n / res) * res;
  inner = [snap(inner[0], Math.floor), snap(inner[1], Math.floor), snap(inner[2], Math.ceil), snap(inner[3], Math.ceil)];
  const bbox: BBox = [inner[0] - PAD_M, inner[1] - PAD_M, inner[2] + PAD_M, inner[3] + PAD_M];

  const id = ++regionSeq;
  region = { id, bbox, innerBox: inner, res, loaded: false };
  if (sheetsFor(bbox).length === 0) {
    hideShade();
    setStatus('この範囲はLINZの1m LiDARデータがありません。影は表示していません。', 'warn');
    return;
  }
  setStatus(`高さデータ（LINZ LiDAR ${res}m）を読み込み中…`);
  worker.postMessage({ type: 'load', id, bbox, res, pad: PAD_M, buildings: collectBuildings(bbox), lots: [] });
  fetchLots(id, bbox, inner);
}

function hideShade() {
  const src = map.getSource('shade') as ImageSource | undefined;
  src?.updateImage({ url: EMPTY_IMG, coordinates: TINY });
}

// OpenStreetMap（OpenFreeMap）の建物ポリゴンを集める → 影が「建物」か「樹木」かの判定に使用
function collectBuildings(bbox: BBox) {
  const out: [number, number][][][] = [];
  let feats: GeoJSON.Feature[] = [];
  try {
    feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' });
  } catch { /* ignore */ }
  for (const f of feats) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const rings = poly.map((r) => r.map(([lng, lat]) => toNZTM(lng, lat)));
      const r0 = rings[0];
      if (!r0?.length) continue;
      const xs = r0.map((p) => p[0]), ys = r0.map((p) => p[1]);
      if (Math.max(...xs) < bbox[0] || Math.min(...xs) > bbox[2] || Math.max(...ys) < bbox[1] || Math.min(...ys) > bbox[3]) continue;
      out.push(rings);
    }
  }
  return out;
}

// ---------- 駐車場（OpenStreetMap / Overpass API） ----------
async function fetchLots(id: number, bbox: BBox, inner: BBox) {
  const sw = toLngLat(inner[0], inner[1]), ne = toLngLat(inner[2], inner[3]);
  const q = `[out:json][timeout:20];(way["amenity"="parking"](${sw[1]},${sw[0]},${ne[1]},${ne[0]});relation["amenity"="parking"](${sw[1]},${sw[0]},${ne[1]},${ne[0]}););out geom;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
    if (!res.ok) throw new Error(String(res.status));
    const js = await res.json();
    if (id !== regionSeq) return;
    const feats: GeoJSON.Feature[] = [];
    const lotsMsg: { id: string; rings: [number, number][][] }[] = [];
    for (const el of js.elements ?? []) {
      let rings: [number, number][][] = [];
      if (el.type === 'way' && el.geometry) rings = [el.geometry.map((p: any) => [p.lon, p.lat])];
      else if (el.type === 'relation') rings = (el.members ?? []).filter((m: any) => m.geometry && m.role !== 'inner').map((m: any) => m.geometry.map((p: any) => [p.lon, p.lat]));
      rings = rings.filter((r) => r.length >= 4);
      if (!rings.length) continue;
      const lid = `${el.type}/${el.id}`;
      const t = el.tags ?? {};
      const name = t.name || (t.parking === 'street_side' ? '路肩駐車スペース' : t.parking === 'multi-storey' ? '立体駐車場' : t.parking === 'underground' ? '地下駐車場' : '駐車場');
      const covered = t.parking === 'multi-storey' || t.parking === 'underground' || t.covered === 'yes';
      feats.push({ type: 'Feature', id: feats.length, properties: { lid, name, covered, label: '' }, geometry: { type: 'Polygon', coordinates: rings.map((r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]])) } });
      lotsMsg.push({ id: lid, rings: rings.map((r) => r.map(([lng, lat]) => toNZTM(lng, lat))) });
    }
    lotFeatures = feats;
    (map.getSource('lots') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
    worker.postMessage({ type: 'lots', id, lots: lotsMsg });
    requestShade();
  } catch (e) {
    console.warn('Overpass', e);
    lotFeatures = [];
    renderLotList(true);
  }
}

// ---------- 影の計算 ----------
function requestShade() {
  if (!region?.loaded) return;
  if (shadeBusy) { shadePending = true; return; }
  shadeBusy = true;
  const { azN, alt } = sunInfo();
  // ワーカーは「南=0・西回り・ラジアン」で計算
  worker.postMessage({ type: 'shade', id: region.id, seq: ++shadeSeq, azimuth: ((azN - 180) * Math.PI) / 180, altitude: (alt * Math.PI) / 180 });
}

const canvas = document.createElement('canvas');
let lastUrl = '';

worker.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'loaded') {
    if (!region || m.id !== region.id) return;
    region.loaded = true;
    if (m.nodata >= 0.999) {
      hideShade();
      setStatus('この範囲はLiDAR測量データがありません。影は表示していません。', 'warn');
      return;
    }
    requestShade();
  } else if (m.type === 'error') {
    shadeBusy = false;
    if (region && m.id === region.id) {
      hideShade();
      setStatus(`高さデータを取得できませんでした（${m.message}）。通信状態を確認してください。影は表示していません。`, 'err');
      region = null;
    }
  } else if (m.type === 'shade') {
    shadeBusy = false;
    if (shadePending) { shadePending = false; requestShade(); }
    if (!region || m.id !== region.id) return;
    canvas.width = m.w;
    canvas.height = m.h;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(m.rgba), m.w, m.h), 0, 0);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const url = URL.createObjectURL(blob);
    const [x0, y0, x1, y1] = m.bbox as BBox;
    (map.getSource('shade') as ImageSource).updateImage({
      url,
      coordinates: [toLngLat(x0, y1), toLngLat(x1, y1), toLngLat(x1, y0), toLngLat(x0, y0)],
    });
    if (lastUrl) setTimeout(((u) => () => URL.revokeObjectURL(u))(lastUrl), 2000);
    lastUrl = url;
    lastLots = m.lots;
    renderLotList();
    const tm = fmtMin(Number(timeEl.value));
    if (m.night) setStatus(`${tm} は日没後です。全体が日陰です（木の下・データなしのみ色分け）。`);
    else if (m.nodata > 0.02)
      setStatus(`${tm} の日陰を表示中（解像度${region.res}m）。灰色の斜線は測量データがなく、影を計算していない場所です。`, 'warn');
    else setStatus(`${tm} の日陰を表示中（LINZ LiDAR ${region.res}m）。濃い青＝建物の影、薄い青・緑＝樹木（予測）。`);
  }
};

// ---------- 駐車場リスト ----------
function renderLotList(failed = false) {
  const list = $('lotList');
  if (failed) { list.innerHTML = '<p class="muted">駐車場データ（OpenStreetMap）を取得できませんでした。地図の影表示は使えます。</p>'; return; }
  const byId = new Map(lastLots.map((l) => [l.id, l]));
  const rows = lotFeatures
    .map((f) => ({ f, s: byId.get(f.properties!.lid) }))
    .filter((r) => r.s && r.s.area >= 20)
    .sort((a, b) => b.s!.solid + b.s!.tree - (a.s!.solid + a.s!.tree));
  $('lotCount').textContent = rows.length ? String(rows.length) : '';
  // 地図上のラベル（日陰率）
  for (const r of rows) r.f.properties!.label = `${Math.round((r.s!.solid + r.s!.tree) * 100)}%`;
  (map.getSource('lots') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lotFeatures });
  if (!rows.length) { list.innerHTML = '<p class="muted">表示範囲に駐車場が見つかりません（OpenStreetMapに登録されている駐車場のみ）。地図の青い部分の道路も参考にしてください。</p>'; return; }
  list.innerHTML = '';
  for (const { f, s } of rows.slice(0, 40)) {
    const pct = Math.round((s!.solid + s!.tree) * 100);
    const div = document.createElement('div');
    div.className = 'lot';
    const covered = f.properties!.covered ? '（屋根付きの可能性：屋内は計算対象外）' : '';
    div.innerHTML = `<div class="bar"><div class="s" style="width:${s!.solid * 100}%"></div><div class="t" style="width:${s!.tree * 100}%"></div></div>
      <div class="name">${escapeHtml(f.properties!.name)}<small>約${Math.round(s!.area).toLocaleString()}㎡・建物影${Math.round(s!.solid * 100)}%／樹木影${Math.round(s!.tree * 100)}%（予測）${covered}</small></div>
      <div class="pct">${pct}%</div>`;
    div.onclick = () => {
      const coords = (f.geometry as GeoJSON.Polygon).coordinates[0];
      const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
      $('lots').classList.add('hidden');
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 18.5 });
    };
    list.appendChild(div);
  }
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function openLots() { $('help').classList.add('hidden'); $('lots').classList.remove('hidden'); }
$('btnLots').addEventListener('click', openLots);
$('btnHelp').addEventListener('click', () => { $('lots').classList.add('hidden'); $('help').classList.remove('hidden'); });
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => $(b.dataset.close!).classList.add('hidden')));

// 初回だけ説明を表示
try {
  if (!localStorage.getItem('helpShown')) { $('help').classList.remove('hidden'); localStorage.setItem('helpShown', '1'); }
} catch { /* ignore */ }
