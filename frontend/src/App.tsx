import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { analyzeDebounced, analyzeRequest } from './api';
import type { AnalyzeResponse, FrequencyBand, OverallComms, DteStatus, PowerStatus } from './api';

/* ============================================================
   Constants
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

/* South Pole landmarks */
const LANDMARKS = [
  { name: 'Shackleton',   lat: -89.9, lon:   0.0 },
  { name: 'Haworth',      lat: -87.4, lon: 340.5 },
  { name: 'Malapert',     lat: -86.0, lon:   2.7 },
  { name: 'Cabeus',       lat: -84.9, lon: 316.0 },
  { name: 'de Gerlache',  lat: -88.5, lon:  30.0 },
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

function moonCartesian(lat: number, lon: number, alt = 0): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromRadians(
    toRad(lon), toRad(lat), alt,
    Cesium.Ellipsoid.MOON,
  );
}

function toRad(d: number): number { return (d * Math.PI) / 180; }

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
   Draw latitude rings & meridians
   ============================================================ */

function addGraticule(viewer: Cesium.Viewer): void {
  const latLines = [-89, -88, -87, -86, -85];
  for (const lat of latLines) {
    const pts: Cesium.Cartesian3[] = [];
    for (let lon = 0; lon <= 360; lon += 2) {
      pts.push(moonCartesian(lat, lon, 100));
    }
    viewer.entities.add({
      polyline: {
        positions: pts,
        width: 0.5,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#444444'),
        ),
        clampToGround: false,
      },
    });

    // Label at lon=0
    viewer.entities.add({
      position: moonCartesian(lat, 0, 2000),
      label: {
        text: `${lat}°`,
        font: '10px Georgia, serif',
        fillColor: Cesium.Color.fromCssColorString('#888888'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -4),
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
      position: moonCartesian(-84.5, lon, 2000),
      label: {
        text: `${lon}°`,
        font: '9px Georgia, serif',
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
   Draw landmark labels
   ============================================================ */

function addLandmarkLabels(viewer: Cesium.Viewer): void {
  for (const lm of LANDMARKS) {
    viewer.entities.add({
      position: moonCartesian(lm.lat, lm.lon, 3000),
      label: {
        text: lm.name,
        font: '11px Georgia, serif',
        fillColor: Cesium.Color.fromCssColorString('#CCCCCC'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }
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
  const relayRayRef    = useRef<Cesium.Entity | null>(null);

  /* State */
  const [lat, setLat]   = useState<number>(-89.9);
  const [lon, setLon]   = useState<number>(0.0);
  const [band, setBand] = useState<FrequencyBand>('X_BAND');
  const [timeHours, setTimeHours] = useState<number>(0);
  const [playing, setPlaying]     = useState<boolean>(false);
  const [result, setResult]       = useState<AnalyzeResponse | null>(null);
  const [activePreset, setActivePreset] = useState<number>(0);

  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Derived UTC */
  const utcTime = new Date(TIME_START.getTime() + timeHours * 3_600_000).toISOString();

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

    viewer.scene.globe.baseColor   = Cesium.Color.fromCssColorString('#141414');
    viewer.scene.backgroundColor   = Cesium.Color.BLACK;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.sun               = undefined as unknown as Cesium.Sun;

    // Try loading ion tileset if token present
    if (ionToken) {
      Cesium.Cesium3DTileset.fromIonAssetId(2684829).then((tileset) => {
        viewer.scene.primitives.add(tileset);
      }).catch(() => {/* no tileset, continue */});
    }

    addGraticule(viewer);
    addLandmarkLabels(viewer);

    // Fly camera to lunar south pole
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(
        toRad(0), toRad(-89.0), MOON_RADIUS * 0.08,
        Cesium.Ellipsoid.MOON,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch:   Cesium.Math.toRadians(-75),
        roll:    0,
      },
      duration: 0,
    });

    // Click handler
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const ray      = viewer.camera.getPickRay(event.position);
      if (!ray) return;
      const pickPos  = viewer.scene.globe.pick(ray, viewer.scene);
      if (!pickPos) return;
      const carto = Cesium.Ellipsoid.MOON.cartesianToCartographic(pickPos);
      const pickedLat = Cesium.Math.toDegrees(carto.latitude);
      const pickedLon = ((Cesium.Math.toDegrees(carto.longitude)) + 360) % 360;
      setLat(parseFloat(pickedLat.toFixed(4)));
      setLon(parseFloat(pickedLon.toFixed(4)));
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

  /* ---- Immediate fetch on preset / band click ---- */
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
    if (markerRef.current)   viewer.entities.remove(markerRef.current);
    if (sunRayRef.current)   viewer.entities.remove(sunRayRef.current);
    if (relayRayRef.current) viewer.entities.remove(relayRayRef.current);
    commsRayRef.current.forEach((e) => viewer.entities.remove(e));
    commsRayRef.current = [];

    /* Landing site marker — white ring + red fill */
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

    const RAY_LENGTH = MOON_RADIUS * 0.03; // ~52 km

    /* Sun ray */
    const isShadow = result.sun.power_status === 'CRITICAL_SHADOW';
    const sunLen   = isShadow ? RAY_LENGTH * 0.3 : RAY_LENGTH;
    const sunEnd   = azElToCartesian(lat, lon, result.sun.azimuth_deg, result.sun.elevation_deg, sunLen);
    sunRayRef.current = viewer.entities.add({
      polyline: {
        positions: [markerPos, sunEnd],
        width: isShadow ? 1 : 2,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#FFFF00').withAlpha(isShadow ? 0.4 : 1.0),
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
            width: 2,
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
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#FFAA00'),
              dashLength: 16,
            }),
            clampToGround: false,
          },
        }),
      );
    } else {
      // COMPLETE_BLACKOUT — short red stub
      const blockedEnd = azElToCartesian(lat, lon, result.earth.azimuth_deg, result.earth.elevation_deg, RAY_LENGTH * 0.2);
      commsRayRef.current.push(
        viewer.entities.add({
          polyline: {
            positions: [markerPos, blockedEnd],
            width: 2,
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

  const togglePlay = () => setPlaying((p) => !p);

  /* ============================================================
     Render
     ============================================================ */
  return (
    <div className="app-layout">
      {/* ---- Left: 3D Cesium Globe ---- */}
      <div className="cesium-pane">
        <div className="cesium-container" ref={cesiumContainerRef} />
      </div>

      {/* ---- Right: Control & Telemetry Panel ---- */}
      <div className="control-panel">

        {/* Header */}
        <div className="panel-header">
          <div className="panel-title">Lunar South Pole Navigator</div>
          <div className="panel-subtitle">NASA Space Apps Challenge — Landing Site Analysis</div>
          {result && (
            <span className={`source-indicator ${result.source === 'LIVE' ? 'source-live' : 'source-offline'}`}>
              SOURCE: {result.source === 'LIVE' ? 'LIVE C++ ENGINE' : 'OFFLINE FALLBACK'}
            </span>
          )}
        </div>

        {/* Preset Sites */}
        <div className="panel-section">
          <div className="section-label">Preset Landing Sites</div>
          <div className="preset-grid">
            {PRESETS.map((p, i) => (
              <button
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
                key={b.key}
                className={`band-btn${band === b.key ? ' active' : ''}`}
                onClick={() => handleBand(b.key)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {/* Time Scrubber */}
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
          <button
            className={`play-btn${playing ? ' playing' : ''}`}
            onClick={togglePlay}
          >
            {playing ? '▐▐  PAUSE' : '▶  PLAY'}
          </button>
        </div>

        {/* ---- Telemetry ---- */}

        {/* 1. Site Coordinates */}
        <div className="panel-section">
          <div className="section-label">Site Coordinates</div>
          <table className="telem-table">
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
