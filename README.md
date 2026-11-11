# Albany 日陰ファインダー

Westfield Albany（オークランド）から半径10km以内で、車を日陰に停められる場所を日時を指定して予測するスマホ用Webアプリ（PWA）です。

## 仕組み
- 地図: MapLibre GL JS + OpenFreeMap（OpenStreetMap）
- 高さ: LINZ NZ Elevation の全国 1m LiDAR DSM / DEM（Cloud Optimised GeoTIFF、`s3://nz-elevation/new-zealand/new-zealand/`）をブラウザから必要な範囲だけ読み込み
- 太陽: SunCalc
- 影: 各地点（車の高さ約1m）から太陽の方向へ光線を伸ばし、DSMでさえぎられるかを Web Worker で計算
- 建物/樹木の区別: OpenStreetMap の建物ポリゴン（建物でない2m以上の物体は樹木として「予測」扱い）
- 駐車場: OpenStreetMap（Overpass API）の amenity=parking

## 開発
```
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ に出力
```

## 公開
`main` ブランチに push すると GitHub Actions が GitHub Pages に公開します（リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください）。

## データの出典
標高データ: Toitū Te Whenua LINZ / NZ Elevation（CC BY 4.0）。地図: © OpenMapTiles © OpenStreetMap contributors。
