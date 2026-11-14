# Antigravity Agent Guidelines: Lunar Landing Site Navigator

## Workspace Boundaries
- **Backend Scope (`backend/`):** All C++17 source files, headers, `CMakeLists.txt`, and backend `Dockerfile` live inside `backend/`.
- **Frontend Scope (`frontend/`):** React + Vite + TypeScript + TailwindCSS + CesiumJS web application lives inside `frontend/`.
- Never mix backend and frontend edits inside the same agent task unless explicitly instructed.

## Backend Rules (`backend/`)
- Language: C++17 | Build: CMake (`backend/CMakeLists.txt`)
- REST API: Crow (`crow_all.h`) listening on port `9091` with CORS headers (`Access-Control-Allow-Origin: *`).
- Geospatial: GDAL (`libgdal-dev`) preserving lunar sphere radius ($R_{\text{Moon}} = 1737400.0\text{ m}$).

## Frontend Rules (`frontend/`)
- Framework: React 18 + Vite + TypeScript + TailwindCSS.
- 3D Engine: CesiumJS configured with `Cesium.Ellipsoid.MOON`.
- Live API Endpoint: `https://lunar-api.andreos.org/api/v1/analyze` (with automatic offline fallback presets if the network request fails).