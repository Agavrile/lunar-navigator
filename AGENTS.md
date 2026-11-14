# Antigravity Agent Guidelines: Lunar Landing Site Navigator

## Workspace Boundaries
- **Backend Scope (`backend/`):** C++17 source files, headers, `CMakeLists.txt`, and `Dockerfile`.
- **Frontend Scope (`frontend/`):** React 18 + Vite + TypeScript + CesiumJS + plain CSS web application.
- Never modify files outside `frontend/` during frontend tasks.

## Frontend Design & Engineering Rules (`frontend/`)
- **Aesthetic:** Pure utilitarian NASA technical instrumentation style. Pure `#000000` black background, `#FFFFFF` / `#CCCCCC` text, sharp `0px` corners, `1px solid #555555` borders, and `Georgia, "Times New Roman", Times, serif` typography.
- **Strict Visual Prohibitions:** NO TailwindCSS, NO CSS gradients, NO box-shadows, NO glassmorphism, NO rounded pill badges, NO CSS animations or transitions. Use pure solid colors only (`#000000`, `#FFFFFF`, `#00CC00`, `#FFAA00`, `#FF3333`, `#FFFF00`).
- **3D Engine:** CesiumJS configured with `Cesium.Ellipsoid.MOON`.
- **Live API Endpoint:** `https://lunar-api.andreos.org/api/v1/analyze` with deterministic offline TypeScript fallback.