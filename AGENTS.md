# Antigravity Agent Guidelines: Lunar Landing Site Navigator

## Workspace Boundaries
- **Backend Scope (`backend/`):** All C++ source files, headers, `CMakeLists.txt`, and `Dockerfile` must live exclusively inside `backend/`.
- **Frontend Scope (`frontend/`):** Do not create, modify, or delete any files inside `frontend/` unless explicitly instructed for a UI task.

## Architecture Rules
- Language: C++17
- Build System: CMake (`backend/CMakeLists.txt`)
- Web Framework: Crow (`crow_all.h`) REST API on port 8080
- Topography Engine: GDAL (`libgdal-dev`) handling South Polar Stereographic GeoTIFFs
- HTTP Client: `libcurl` for NASA JPL Horizons API queries
- JSON Library: `nlohmann/json`

## Agent Separation of Concerns
1. **Infrastructure Agent:** Edits `backend/Dockerfile`, `backend/CMakeLists.txt`, and `backend/main.cpp`.
2. **Topography Agent:** Edits `backend/gdal_parser.h` and `backend/gdal_parser.cpp`.
3. **Space Agent:** Edits `backend/jpl_ephemeris.h` and `backend/jpl_ephemeris.cpp`.
4. **Physics Agent:** Edits `backend/radio_comms.h` and `backend/radio_comms.cpp`.

## Security & Workflow
- Never execute deployment commands or SSH operations; only generate and test files locally.
- Output all `/api/v1/analyze` responses strictly as JSON with CORS headers enabled (`Access-Control-Allow-Origin: *`).