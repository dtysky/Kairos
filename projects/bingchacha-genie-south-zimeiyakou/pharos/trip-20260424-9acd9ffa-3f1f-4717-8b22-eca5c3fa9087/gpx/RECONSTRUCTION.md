# GPX Reconstruction Notes

Trip: `trip-20260424-9acd9ffa-3f1f-4717-8b22-eca5c3fa9087`

Date: `2026-04-25`

Reason: Pyxis did not have background location permission enabled, so parts of the day were not sampled as original GPS track points.

Original route note from user:

> 09:57 to 16:50, from Nanning Nanzhan Expressway to Wanfenglin Zhongnahui Village ground parking lot; Nanzhan Expressway -> Nanning Ring Expressway -> Guangkun Expressway -> Yinbai Expressway -> Shankun Expressway -> Xingyi Ring Expressway.

Generated local reconstruction files:

- `day1-1057-1435-reconstructed.gpx`
  - Fills the large original GPX gap from `2026-04-25T10:57:37+08:00` to `2026-04-25T14:35:45+08:00`.
  - Anchors: existing GPX points `[108.0006572, 22.9212827]` -> `[105.9977295, 24.4873556]`.
  - Geometry source: OSRM driving route.
  - Distance: about `284.43 km`.

- `day1-1636-1650-reconstructed.gpx`
  - Fills the final approach from `2026-04-25T16:36:02+08:00` to `2026-04-25T16:50:00+08:00`.
  - Anchors: existing GPX point `[104.9297832, 25.0279494]` -> Amap POI `B0HUDSKAKY` converted from GCJ-02 to WGS84 `[104.9209822, 24.9867071]`.
  - Geometry source: OSRM driving route.
  - Distance: about `5.86 km`.

The reconstructed GPX files are derived data for visualization and review. They are not original Pyxis GPS samples and should not be treated as raw telemetry.
