# Vendored libraries

Pinned copies so the simulator works without network access during a live demo.

| File | Library | Version | Source | License |
|---|---|---|---|---|
| `leaflet/leaflet.js`, `leaflet/leaflet.css` | Leaflet | 1.9.4 | https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/ | BSD-2-Clause |
| `chart.umd.min.js` | Chart.js | 4.4.1 | https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js | MIT |
| `mathjax/tex-svg.js` | MathJax (TeX → SVG, single-file) | 3.2.2 | https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js | Apache-2.0 |

Basemap tiles (CARTO Dark Matter) are the only runtime network dependency; the road graph and all algorithms work offline.
