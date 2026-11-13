# Antigravity Agent Guidelines: Lunar Landing Site Navigator

## Architecture Rules
- Language: C++ (Standard C++17 or newer)
- Build System: CMake
- Web Framework: Crow (C++ microframework) for the REST API.
- Topography Engine: GDAL (Geospatial Data Abstraction Library).
- HTTP Client: libcurl (for querying NASA JPL Horizons).

## Agent Separation of Concerns
1. **Infrastructure Agent:** Only edits `Dockerfile`, `CMakeLists.txt`, and server initialization.
2. **Topography Agent:** Only edits `gdal_parser.cpp` and `gdal_parser.h`. Must handle South Polar Stereographic projections.
3. **Space Agent:** Only edits `jpl_ephemeris.cpp` and `jpl_ephemeris.h`.
4. **Physics Agent:** Only edits `radio_comms_engine.cpp` and integrates the logic.

## Security & Workflow
- Do not run system-level commands outside of Docker build contexts.
- Output all API responses strictly as JSON.