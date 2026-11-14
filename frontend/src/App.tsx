import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { analyzeDebounced, analyzeRequest } from './api';
import type { AnalyzeResponse, FrequencyBand, OverallComms, DteStatus, PowerStatus } from './api';

/* ============================================================
   Constants & Features
   ============================================================ */

const TIME_START = new Date('2026-11-14T00:00:00Z');
const TIME_END   = new Date('2026-12-14T00:00:00Z');
const TOTAL_HOURS = Math.round((TIME_END.getTime() - TIME_START.getTime()) / 3_600_000);

interface PresetSite {
  name: string;
  lat: number;
  lon: number;
}

const PRESETS: PresetSite[] = [
  { name: 'Shackleton Rim',    lat: -89.9, lon:   0.0 },
  { name: 'Malapert Massif',   lat: -86.0, lon:   2.7 },
  { name: 'Haworth PSR',       lat: -87.4, lon: 340.5 },
  { name: 'Connecting Ridge',  lat: -89.4, lon: 222.0 },
];

const BANDS: { key: FrequencyBand; label: string }[] = [
  { key: 'S_BAND',  label: 'S-BAND (2.2 GHz)' },
  { key: 'X_BAND',  label: 'X-BAND (8.4 GHz)' },
  { key: 'KA_BAND', label: 'KA-BAND (26.0 GHz)' },
];

/* Official IAU Planetary Nomenclature coordinates & radii */
interface CraterFeature {
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

const IAU_CRATERS: CraterFeature[] = [
  { name: 'Shackleton', lat: -89.67, lon: 129.78, radiusM: 10460 },
  { name: 'Haworth',    lat: -87.45, lon: 354.83, radiusM: 25710 },
  { name: 'Shoemaker',  lat: -88.14, lon:  45.91, radiusM: 25910 },
  { name: 'Faustini',   lat: -87.18, lon:  84.31, radiusM: 21240 },
  { name: 'Cabeus',     lat: -85.33, lon: 317.87, radiusM: 50290 },
];

const MOON_RADIUS = 1_737_400; // metres

/* ============================================================
   Colour helpers
   ============================================================ */

function dteColor(s: DteStatus): string {
  if (s === 'CLEAR') return '#00CC00';
  if (s === 'DIFFRACTION_WARNING') return '#FFAA00';
  return '#FF3333';
}

function powerColor(s: PowerStatus): string {
  if (s === 'OPTIMAL') return '#00CC00';
  if (s === 'LOW_POWER') return '#FFAA00';
  return '#FF3333';
}

function commsColor(s: OverallComms): string {
  if (s === 'DIRECT_DTE')     return '#00CC00';
  if (s === 'RELAY_AVAILABLE') return '#FFAA00';
  return '#FF3333';
}

function dteClass(s: DteStatus): string {
  if (s === 'CLEAR') return 'status-clear';
  if (s === 'DIFFRACTION_WARNING') return 'status-warn';
  return 'status-critical';
}

function powerClass(s: PowerStatus): string {
  if (s === 'OPTIMAL') return 'status-clear';
  if (s === 'LOW_POWER') return 'status-warn';
  return 'status-critical';
}

function commsClass(s: OverallComms): string {
  if (s === 'DIRECT_DTE')     return 'status-clear';
  if (s === 'RELAY_AVAILABLE') return 'status-warn';
  return 'status-critical';
}

function fmt(n: number, dec = 2): string {
  return n.toFixed(dec);
}

/* ============================================================
   Cesium utilities
   ============================================================ */

function toRad(d: number): number { return (d * Math.PI) / 180; }

function moonCartesian(lat: number, lon: number, alt = 0): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromRadians(
    toRad(lon), toRad(lat), alt,
    Cesium.Ellipsoid.MOON,
  );
}

function computeCirclePositions(centerLat: number, centerLon: number, radiusM: number, segments = 64): Cesium.Cartesian3[] {
  const pts: Cesium.Cartesian3[] = [];
  const lat0 = toRad(centerLat);
  const lon0 = toRad(centerLon);
  const d = radiusM / MOON_RADIUS;

  for (let i = 0; i <= segments; i++) {
    const bearing = (i * 2 * Math.PI) / segments;
    const sinLat = Math.sin(lat0) * Math.cos(d) + Math.cos(lat0) * Math.sin(d) * Math.cos(bearing);
    const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
    const y = Math.sin(bearing) * Math.sin(d) * Math.cos(lat0);
    const x = Math.cos(d) - Math.sin(lat0) * Math.sin(lat);
    const lon = lon0 + Math.atan2(y, x);

    pts.push(Cesium.Cartesian3.fromRadians(lon, lat, 200, Cesium.Ellipsoid.MOON));
  }
  return pts;
}

function azElToCartesian(
  originLat: number,
  originLon: number,
  azDeg: number,
  elDeg: number,
  lengthM: number,
): Cesium.Cartesian3 {
  const originCart = moonCartesian(originLat, originLon, 10);
  const az  = toRad(azDeg);
  const el  = toRad(elDeg);

  // Local East-North-Up frame
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(originCart, Cesium.Ellipsoid.MOON);
  const local = new Cesium.Cartesian3(
    Math.sin(az) * Math.cos(el) * lengthM,
    Math.cos(az) * Math.cos(el) * lengthM,
    Math.sin(el) * lengthM,
  );
  const world = new Cesium.Cartesian3();
  Cesium.Matrix4.multiplyByPoint(enu, local, world);
  return world;
}

/* ============================================================
   Draw latitude rings & meridians with exact Artemis zone labels
   ============================================================ */

function addGraticule(viewer: Cesium.Viewer): void {
  const latLines = [-89, -88, -87, -86, -85];
  for (const lat of latLines) {
    const pts: Cesium.Cartesian3[] = [];
    for (let lon = 0; lon <= 360; lon += 1) {
      pts.push(moonCartesian(lat, lon, 100));
    }
    viewer.entities.add({
      polyline: {
        positions: pts,
        width: 1.0,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString(lat === -85 ? '#777777' : '#555555'),
        ),
        clampToGround: false,
      },
    });

    // Label along 0° meridian with radial scale
    let labelText = `${Math.abs(lat)}°S`;
    let isArtemisZone = false;

    if (lat === -89) {
      labelText = '89°S (30 km)';
    } else if (lat === -87) {
      labelText = '87°S (91 km)';
    } else if (lat === -85) {
      labelText = '85°S · 152 km (ARTEMIS SOUTH POLE ZONE)';
      isArtemisZone = true;
    }

    viewer.entities.add({
      position: moonCartesian(lat, 0, 1800),
      label: {
        text: labelText,
        font: isArtemisZone
          ? 'bold 11px Georgia, "Times New Roman", Times, serif'
          : '10px Georgia, "Times New Roman", Times, serif',
        fillColor: isArtemisZone
          ? Cesium.Color.fromCssColorString('#E0E0E0')
          : Cesium.Color.fromCssColorString('#888888'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        pixelOffset: new Cesium.Cartesian2(4, -3),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // Meridians every 30°
  for (let lon = 0; lon < 360; lon += 30) {
    const pts: Cesium.Cartesian3[] = [];
    for (let lat = -90; lat <= -83; lat += 0.5) {
      pts.push(moonCartesian(lat, lon, 100));
    }
    viewer.entities.add({
      polyline: {
        positions: pts,
        width: 0.5,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#333333'),
        ),
        clampToGround: false,
      },
    });
    viewer.entities.add({
      position: moonCartesian(-84.2, lon, 2000),
      label: {
        text: `${lon}°`,
        font: '9px Georgia, "Times New Roman", Times, serif',
        fillColor: Cesium.Color.fromCssColorString('#666666'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }
}

/* ============================================================
   Draw IAU Crater Rims and Malapert Massif Elevation Landmark
   ============================================================ */

function addCraters(viewer: Cesium.Viewer): void {
  // 1. IAU Crater Rims and Labels
  for (const c of IAU_CRATERS) {
    // 1.5px gray circle for IAU crater rim
    viewer.entities.add({
      name: `${c.name} Crater Rim`,
      polyline: {
        positions: computeCirclePositions(c.lat, c.lon, c.radiusM, 64),
        width: 1.5,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#888888'),
        ),
        clampToGround: false,
      },
    });

    // Crater name label
    viewer.entities.add({
      name: `${c.name} Label`,
      position: moonCartesian(c.lat, c.lon, 2500),
      label: {
        text: c.name,
        font: '11px Georgia, "Times New Roman", Times, serif',
        fillColor: Cesium.Color.fromCssColorString('#CCCCCC'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // 2. Malapert Massif (Elevated Mountain Massif Peak)
  viewer.entities.add({
    name: 'Malapert Massif Peak',
    position: moonCartesian(-86.0, 2.7, 5000),
    point: {
      pixelSize: 6,
      color: Cesium.Color.fromCssColorString('#CCCCCC'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: '▲ Malapert Massif',
      font: '11px Georgia, "Times New Roman", Times, serif',
      fillColor: Cesium.Color.fromCssColorString('#CCCCCC'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -6),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

/* ============================================================
   App Component
   ============================================================ */

export default function App(): React.ReactElement {
  const cesiumContainerRef = useRef<HTMLDivElement>(null);
  const viewerRef          = useRef<Cesium.Viewer | null>(null);

  /* Entity refs for cleanup */
  const markerRef      = useRef<Cesium.Entity | null>(null);
  const sunRayRef      = useRef<Cesium.Entity | null>(null);
  const commsRayRef    = useRef<Cesium.Entity[]>([]);

  /* State */
  const [lat, setLat]   = useState<number>(-89.9);
  const [lon, setLon]   = useState<number>(0.0);
  const [inputLat, setInputLat] = useState<string>('-89.9000');
  const [inputLon, setInputLon] = useState<string>('0.0000');
  const [band, setBand] = useState<FrequencyBand>('X_BAND');
  const [timeHours, setTimeHours] = useState<number>(0);
  const [playing, setPlaying]     = useState<boolean>(false);
  const [result, setResult]       = useState<AnalyzeResponse | null>(null);
  const [activePreset, setActivePreset] = useState<number>(0);

  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Derived UTC */
  const utcTime = new Date(TIME_START.getTime() + timeHours * 3_600_000).toISOString();

  /* ---- Reset Camera to Pole View ---- */
  const handleResetPoleView = () => {
    if (!viewerRef.current) return;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(0.0, -90.0, 420000, Cesium.Ellipsoid.MOON),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 1,
    });
  };

  /* ---- Init Cesium ---- */
  useEffect(() => {
    if (!cesiumContainerRef.current || viewerRef.current) return;

    // Set Moon ellipsoid BEFORE creating the viewer
    Cesium.Ellipsoid.default = Cesium.Ellipsoid.MOON;

    const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
    if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

    const viewer = new Cesium.Viewer(cesiumContainerRef.current, {
      baseLayer: false as unknown as Cesium.ImageryLayer,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyBox: false as unknown as Cesium.SkyBox,
      skyAtmosphere: false as unknown as Cesium.SkyAtmosphere,
    });

    viewer.scene.globe.show = true;
    viewer.scene.globe.enableLighting = false;
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = false;
    }
    if (viewer.scene.fog) {
      viewer.scene.fog.enabled = false;
    }
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#2B2B2B');
    viewer.scene.backgroundColor = Cesium.Color.BLACK;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.sun = undefined as unknown as Cesium.Sun;

    // Real NASA Moon Trek LRO WAC Global Mosaic
    const lunarImagery = new Cesium.UrlTemplateImageryProvider({
      url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
      tilingScheme: new Cesium.GeographicTilingScheme(),
      maximumLevel: 7,
      credit: 'NASA LRO WAC',
    });
    viewer.imageryLayers.addImageryProvider(lunarImagery);

    // Try loading ion tileset if token present
    if (ionToken) {
      Cesium.Cesium3DTileset.fromIonAssetId(2684829).then((tileset) => {
        viewer.scene.primitives.add(tileset);
      }).catch(() => {/* no tileset, continue */});
    }

    addGraticule(viewer);
    addCraters(viewer);

    // Initial camera: clean top-down polar view directly at South Pole
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(0.0, -90.0, 420000, Cesium.Ellipsoid.MOON),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
    });

    // Click handler
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const ray = viewer.camera.getPickRay(event.position);
      if (!ray) return;
      const pickPos = viewer.scene.globe.pick(ray, viewer.scene);
      if (!pickPos) return;
      const carto = Cesium.Ellipsoid.MOON.cartesianToCartographic(pickPos);
      const pickedLat = Cesium.Math.toDegrees(carto.latitude);
      const pickedLon = ((Cesium.Math.toDegrees(carto.longitude)) + 360) % 360;
      const roundLat = parseFloat(pickedLat.toFixed(4));
      const roundLon = parseFloat(pickedLon.toFixed(4));
      setLat(roundLat);
      setLon(roundLon);
      setInputLat(roundLat.toFixed(4));
      setInputLon(roundLon.toFixed(4));
      setActivePreset(-1);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    viewerRef.current = viewer;

    return () => {
      handler.destroy();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  /* ---- Fetch analysis when inputs change ---- */
  useEffect(() => {
    analyzeDebounced({ lat, lon, utc_time: utcTime, frequency_band: band }, setResult, 250);
  }, [lat, lon, utcTime, band]);

  /* ---- Immediate fetch on preset / band / coordinate submit ---- */
  const fetchImmediate = useCallback(
    (newLat: number, newLon: number, newBand: FrequencyBand, newTime: string) => {
      analyzeRequest({ lat: newLat, lon: newLon, utc_time: newTime, frequency_band: newBand })
        .then(setResult)
        .catch(console.error);
    },
    [],
  );

  /* ---- Update 3D overlays when result changes ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !result) return;

    /* Remove old entities */
    if (markerRef.current) viewer.entities.remove(markerRef.current);
    if (sunRayRef.current) viewer.entities.remove(sunRayRef.current);
    commsRayRef.current.forEach((e) => viewer.entities.remove(e));
    commsRayRef.current = [];

    /* Landing site marker — white outline + red center target marker */
    const markerPos = moonCartesian(lat, lon, 50);
    markerRef.current = viewer.entities.add({
      position: markerPos,
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#FF3333'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    const RAY_LENGTH = MOON_RADIUS * 0.04; // ~70 km

    /* Sun ray (#FFFF00) */
    const isShadow = result.sun.power_status === 'CRITICAL_SHADOW';
    const sunLen   = isShadow ? RAY_LENGTH * 0.3 : RAY_LENGTH;
    const sunEnd   = azElToCartesian(lat, lon, result.sun.azimuth_deg, result.sun.elevation_deg, sunLen);
    sunRayRef.current = viewer.entities.add({
      polyline: {
        positions: [markerPos, sunEnd],
        width: isShadow ? 1.5 : 2.5,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#FFFF00').withAlpha(isShadow ? 0.35 : 1.0),
        ),
        clampToGround: false,
      },
    });

    /* Comms rays */
    const comms = result.overall_comms;
    if (comms === 'DIRECT_DTE') {
      const earthEnd = azElToCartesian(lat, lon, result.earth.azimuth_deg, result.earth.elevation_deg, RAY_LENGTH);
      commsRayRef.current.push(
        viewer.entities.add({
          polyline: {
            positions: [markerPos, earthEnd],
            width: 2.5,
            material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#00CC00')),
            clampToGround: false,
          },
        }),
      );
    } else if (comms === 'RELAY_AVAILABLE') {
      // Two-segment: site -> relay overhead -> sky
      const relayMidPt  = azElToCartesian(lat, lon, result.relay.azimuth_deg, result.relay.elevation_deg, RAY_LENGTH * 0.5);
      const relayEndPt  = azElToCartesian(lat, lon, result.relay.azimuth_deg, result.relay.elevation_deg + 10, RAY_LENGTH);
      commsRayRef.current.push(
        viewer.entities.add({
          polyline: {
            positions: [markerPos, relayMidPt, relayEndPt],
            width: 2.5,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#FFAA00'),
              dashLength: 16,
            }),
            clampToGround: false,
          },
        }),
      );
    } else {
      // COMPLETE_BLACKOUT — short red blocked line
      const blockedEnd = azElToCartesian(lat, lon, result.earth.azimuth_deg, result.earth.elevation_deg, RAY_LENGTH * 0.25);
      commsRayRef.current.push(
        viewer.entities.add({
          polyline: {
            positions: [markerPos, blockedEnd],
            width: 2.5,
            material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#FF3333')),
            clampToGround: false,
          },
        }),
      );
    }
  }, [result, lat, lon]);

  /* ---- Playback ---- */
  useEffect(() => {
    if (playing) {
      playIntervalRef.current = setInterval(() => {
        setTimeHours((h) => {
          const next = h + 1;
          if (next >= TOTAL_HOURS) { setPlaying(false); return TOTAL_HOURS; }
          return next;
        });
      }, 100);
    } else {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    }
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [playing]);

  /* ---- Handlers ---- */
  const handlePreset = (idx: number) => {
    const p = PRESETS[idx];
    setLat(p.lat);
    setLon(p.lon);
    setInputLat(p.lat.toFixed(4));
    setInputLon(p.lon.toFixed(4));
    setActivePreset(idx);
    fetchImmediate(p.lat, p.lon, band, utcTime);
  };

  const handleBand = (b: FrequencyBand) => {
    setBand(b);
    fetchImmediate(lat, lon, b, utcTime);
  };

  const handleTimeSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const h = parseInt(e.target.value, 10);
    setTimeHours(h);
    setPlaying(false);
  };

  const handleStepTime = (deltaHours: number) => {
    setPlaying(false);
    setTimeHours((h) => Math.max(0, Math.min(TOTAL_HOURS, h + deltaHours)));
  };

  const togglePlay = () => setPlaying((p) => !p);

  const handleApplyCoords = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsedLat = parseFloat(inputLat);
    const parsedLon = parseFloat(inputLon);
    if (isNaN(parsedLat) || isNaN(parsedLon)) return;
    const clampedLat = Math.max(-90, Math.min(90, parsedLat));
    const normalizedLon = ((parsedLon % 360) + 360) % 360;
    const roundLat = parseFloat(clampedLat.toFixed(4));
    const roundLon = parseFloat(normalizedLon.toFixed(4));
    setLat(roundLat);
    setLon(roundLon);
    setInputLat(roundLat.toFixed(4));
    setInputLon(roundLon.toFixed(4));
    setActivePreset(-1);
    fetchImmediate(roundLat, roundLon, band, utcTime);
  };

  /* ============================================================
     Render
     ============================================================ */
  return (
    <div className="app-layout">
      {/* ---- Left: 3D Cesium Globe ---- */}
      <div className="cesium-pane">
        <button
          type="button"
          className="reset-view-btn"
          onClick={handleResetPoleView}
          title="Reset Camera to Top-Down South Pole View"
        >
          RESET POLE VIEW
        </button>

        <div className="cesium-container" ref={cesiumContainerRef} />

        {/* Vector & Map Legend */}
        <div className="map-vector-legend" aria-label="Map Vector Legend">
          <div className="legend-title">MAP VECTOR LEGEND</div>
          <div className="legend-item">
            <span className="legend-swatch line-yellow" />
            <span className="legend-label">#FFFF00: Solar Illumination Ray (Truncated if Shadowed)</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch line-green" />
            <span className="legend-label">#00CC00: Direct-to-Earth (DTE) Clear Link</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch line-amber" />
            <span className="legend-label">#FFAA00: LunaNet Orbital Relay Link (2-Hop)</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch line-red" />
            <span className="legend-label">#FF3333: Terrain-Blocked Line of Sight</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch target-crosshair">⌖</span>
            <span className="legend-label">#FFFFFF: Selected Landing Site</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch ring-gray">○</span>
            <span className="legend-label">#888888: IAU Crater Rims &amp; Polar Grid (85°S–90°S Artemis Zone, 152 km Radius)</span>
          </div>
        </div>
      </div>

      {/* ---- Right: Control & Telemetry Panel ---- */}
      <div className="control-panel">

        {/* Header with Project/Team Logo */}
        <div className="panel-header">
          <div className="panel-header-content">
            <div className="panel-title">Lunar South Pole Navigator</div>
            <div className="panel-subtitle">NASA Space Apps Challenge — Landing Site Analysis</div>
            {result && (
              <span className={`source-indicator ${result.source === 'LIVE' ? 'source-live' : 'source-offline'}`}>
                SOURCE: {result.source === 'LIVE' ? 'LIVE C++ ENGINE' : 'OFFLINE FALLBACK'}
              </span>
            )}
          </div>
          <img
            src="/logo.png"
            alt="Mission Logo"
            className="mission-logo"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>

        {/* Preset Sites */}
        <div className="panel-section">
          <div className="section-label">Preset Landing Sites</div>
          <div className="preset-grid">
            {PRESETS.map((p, i) => (
              <button
                type="button"
                key={p.name}
                className={`preset-btn${activePreset === i ? ' active' : ''}`}
                onClick={() => handlePreset(i)}
              >
                <span className="preset-name">{p.name}</span>
                <span className="preset-coords">({p.lat}°, {p.lon}°)</span>
              </button>
            ))}
          </div>
        </div>

        {/* Frequency Band */}
        <div className="panel-section">
          <div className="section-label">Frequency Band</div>
          <div className="band-row">
            {BANDS.map((b) => (
              <button
                type="button"
                key={b.key}
                className={`band-btn${band === b.key ? ' active' : ''}`}
                onClick={() => handleBand(b.key)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {/* Time Scrubber & Precision Step Controls */}
        <div className="panel-section">
          <div className="section-label">30-Day Libration Time Scrubber</div>
          <div className="time-utc">{utcTime.replace('T', ' ').replace('Z', ' UTC')}</div>
          <input
            type="range"
            className="time-scrubber"
            min={0}
            max={TOTAL_HOURS}
            step={1}
            value={timeHours}
            onChange={handleTimeSlider}
          />
          <div className="time-controls-row">
            <button
              type="button"
              className="time-step-btn"
              onClick={() => handleStepTime(-24)}
              title="Step backward 24 hours"
            >
              -24H
            </button>
            <button
              type="button"
              className="time-step-btn"
              onClick={() => handleStepTime(-1)}
              title="Step backward 1 hour"
            >
              -1H
            </button>
            <button
              type="button"
              className={`play-btn${playing ? ' playing' : ''}`}
              onClick={togglePlay}
            >
              {playing ? '▐▐  PAUSE' : '▶  PLAY'}
            </button>
            <button
              type="button"
              className="time-step-btn"
              onClick={() => handleStepTime(1)}
              title="Step forward 1 hour"
            >
              +1H
            </button>
            <button
              type="button"
              className="time-step-btn"
              onClick={() => handleStepTime(24)}
              title="Step forward 24 hours"
            >
              +24H
            </button>
          </div>
        </div>

        {/* ---- Telemetry ---- */}

        {/* 1. Site Coordinates & Direct Input */}
        <div className="panel-section">
          <div className="section-label">Site Coordinates</div>
          <form className="coord-form" onSubmit={handleApplyCoords}>
            <div className="coord-inputs">
              <div className="coord-field">
                <label className="coord-label" htmlFor="lat-input">LAT (°)</label>
                <input
                  id="lat-input"
                  type="number"
                  step="any"
                  className="coord-input"
                  value={inputLat}
                  onChange={(e) => setInputLat(e.target.value)}
                  placeholder="-89.9000"
                />
              </div>
              <div className="coord-field">
                <label className="coord-label" htmlFor="lon-input">LON (°)</label>
                <input
                  id="lon-input"
                  type="number"
                  step="any"
                  className="coord-input"
                  value={inputLon}
                  onChange={(e) => setInputLon(e.target.value)}
                  placeholder="0.0000"
                />
              </div>
              <button type="submit" className="coord-apply-btn">
                APPLY
              </button>
            </div>
          </form>

          <table className="telem-table" style={{ marginTop: '8px' }}>
            <tbody>
              <tr>
                <td>Latitude</td>
                <td>{fmt(lat, 4)}°</td>
              </tr>
              <tr>
                <td>Longitude</td>
                <td>{fmt(lon, 4)}°</td>
              </tr>
              <tr>
                <td>LOLA Elevation</td>
                <td>{result ? fmt(result.site_elevation_m, 0) : '—'} m</td>
              </tr>
              <tr>
                <td>DEM Loaded</td>
                <td>{result ? (result.dem_loaded ? 'YES' : 'NO') : '—'}</td>
              </tr>
              <tr>
                <td>Ephemeris Source</td>
                <td style={{ fontSize: '9px' }}>{result?.ephemeris_source ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 2. DTE Link */}
        <div className="panel-section">
          <div className="section-label">Direct-to-Earth (DTE) Link</div>
          {result && (
            <table className="telem-table">
              <tbody>
                <tr>
                  <td>Status</td>
                  <td className={dteClass(result.earth.dte_status)}>
                    {result.earth.dte_status.replace('_', ' ')}
                  </td>
                </tr>
                <tr>
                  <td>Earth Azimuth</td>
                  <td>{fmt(result.earth.azimuth_deg)}°</td>
                </tr>
                <tr>
                  <td>Earth Elevation</td>
                  <td style={{ color: dteColor(result.earth.dte_status) }}>
                    {fmt(result.earth.elevation_deg)}°
                  </td>
                </tr>
                <tr>
                  <td>Terrain Horizon</td>
                  <td>{fmt(result.earth.horizon_deg)}°</td>
                </tr>
                <tr>
                  <td>Obstacle Distance</td>
                  <td>{fmt(result.earth.peak_distance_km, 1)} km</td>
                </tr>
                <tr>
                  <td>60% Fresnel Clear</td>
                  <td>{fmt(result.earth.fresnel_clearance_m, 1)} m</td>
                </tr>
                <tr>
                  <td>Required Fresnel</td>
                  <td>{fmt(result.earth.required_fresnel_m, 1)} m</td>
                </tr>
                <tr>
                  <td>Fresnel OK</td>
                  <td className={result.earth.fresnel_clear ? 'status-clear' : 'status-critical'}>
                    {result.earth.fresnel_clear ? 'YES' : 'NO'}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

        {/* 3. Orbital Relay */}
        <div className="panel-section">
          <div className="section-label">Orbital Relay Fallback</div>
          {result && (
            <>
              <div
                className={`comms-banner ${commsClass(result.overall_comms)}`}
                style={{ color: commsColor(result.overall_comms) }}
              >
                {result.overall_comms.replace(/_/g, ' ')}
              </div>
              <table className="telem-table">
                <tbody>
                  <tr>
                    <td>Active Relay Node</td>
                    <td>{result.relay.node_name}</td>
                  </tr>
                  <tr>
                    <td>Relay Available</td>
                    <td className={result.relay.available ? 'status-clear' : 'status-critical'}>
                      {result.relay.available ? 'YES' : 'NO'}
                    </td>
                  </tr>
                  <tr>
                    <td>Relay Azimuth</td>
                    <td>{fmt(result.relay.azimuth_deg)}°</td>
                  </tr>
                  <tr>
                    <td>Relay Elevation</td>
                    <td style={{ color: result.relay.available ? '#00CC00' : '#B5B5B5' }}>
                      {fmt(result.relay.elevation_deg)}°
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* 4. Solar Power */}
        <div className="panel-section">
          <div className="section-label">Solar Power Viability</div>
          {result && (
            <table className="telem-table">
              <tbody>
                <tr>
                  <td>Power Status</td>
                  <td className={powerClass(result.sun.power_status)}>
                    {result.sun.power_status.replace('_', ' ')}
                  </td>
                </tr>
                <tr>
                  <td>Sun Azimuth</td>
                  <td>{fmt(result.sun.azimuth_deg)}°</td>
                </tr>
                <tr>
                  <td>Sun Elevation</td>
                  <td style={{ color: powerColor(result.sun.power_status) }}>
                    {fmt(result.sun.elevation_deg)}°
                  </td>
                </tr>
                <tr>
                  <td>Terrain Horizon</td>
                  <td>{fmt(result.sun.horizon_deg)}°</td>
                </tr>
                <tr>
                  <td>Net Solar Margin</td>
                  <td style={{ color: powerColor(result.sun.power_status) }}>
                    {fmt(result.sun.net_deg)}°
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

      </div>{/* end control-panel */}
    </div>
  );
}
