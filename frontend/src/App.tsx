import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
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
  { name: 'Shackleton',  lat: -89.67, lon: 129.78, radiusM: 10460 },
  { name: 'de Gerlache', lat: -88.48, lon: 271.66, radiusM: 16355 },
  { name: 'Shoemaker',   lat: -88.14, lon:  45.91, radiusM: 25910 },
  { name: 'Haworth',     lat: -87.45, lon: 354.83, radiusM: 25710 },
  { name: 'Faustini',    lat: -87.18, lon:  84.31, radiusM: 21240 },
  { name: 'Cabeus',      lat: -85.33, lon: 317.87, radiusM: 50290 },
];

const MOON_RADIUS = 1_737_400; // metres

/* ============================================================
   Time helpers
   ============================================================ */

function formatUtcClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `LIVE UTC: ${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
}

function formatShortWindowUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
}

function toDatetimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
}

/* ============================================================
   Analytical Horizon & 30-Day Mission Window Forecaster
   ============================================================ */

function estimateSouthPoleHorizonDeg(lat: number, lon: number, azDeg: number): number {
  const azRad = (azDeg * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const polarOffset = Math.max(0, 90 + lat);

  // Known south-polar massif & crater rim relief profile
  const malapertDir = ((2.7 - lon) * Math.PI) / 180;
  const massifPeak = 4.2 * Math.exp(-Math.pow(Math.sin((azRad - malapertDir) * 0.5), 2) * 8);
  const rimUndulation = 2.1 + 1.4 * Math.sin(azRad * 2 + lonRad) + 0.8 * Math.cos(azRad * 3 - lonRad);

  // Deep PSR floor penalty (e.g. Haworth / Shackleton interior)
  const isHaworthFloor = Math.hypot(lat - -87.45, ((lon - 354.83 + 540) % 360) - 180) < 0.85;
  const isShackletonFloor = Math.hypot(lat - -89.67, ((lon - 129.78 + 540) % 360) - 180) < 0.35;
  const psrWall = isHaworthFloor ? 14.5 : isShackletonFloor ? 18.0 : 0;

  return Math.max(0.4, Number((rimUndulation + massifPeak + psrWall - polarOffset * 0.12).toFixed(2)));
}

interface PredictionWindow {
  startHour: number;
  endHour: number;
  startLabel: string;
  endLabel: string;
  durationHours: number;
  availabilityPct: number;
}

interface MissionForecast {
  dte: PredictionWindow | null;
  dtePct: number;
  solar: PredictionWindow | null;
  solarPct: number;
  relay: PredictionWindow | null;
  relayPct: number;
  blackoutHours: number;
  blackoutPct: number;
}

function computeMissionForecast(
  lat: number,
  lon: number,
  anchorUtcIso: string,
  anchorResult: AnalyzeResponse | null,
): MissionForecast {
  const anchorMs = new Date(anchorUtcIso).getTime();
  const baseMs = TIME_START.getTime();

  // Calibrate analytical ephemeris phase against active telemetry
  const refSunEl = anchorResult ? anchorResult.sun.elevation_deg : 1.1;
  const refEarthEl = anchorResult ? anchorResult.earth.elevation_deg : -1.5;
  const refEarthAz = anchorResult ? anchorResult.earth.azimuth_deg : 0.0;
  const refSunAz = anchorResult ? anchorResult.sun.azimuth_deg : 90.0;
  const refRelayEl = anchorResult ? anchorResult.relay.elevation_deg : 18.0;

  const DRACONIC_H = 653.09;   // 27.2122 days (Earth latitude libration)
  const ANOMALISTIC_H = 661.31; // 27.5546 days (Earth longitude libration)
  const SYNODIC_H = 708.734;   // 29.53059 days (Solar azimuth rotation)
  const RELAY_PERIOD_H = 12.0; // Frozen elliptical lunar relay orbit

  const dteFlags: boolean[] = new Array(TOTAL_HOURS).fill(false);
  const solarFlags: boolean[] = new Array(TOTAL_HOURS).fill(false);
  const relayFlags: boolean[] = new Array(TOTAL_HOURS).fill(false);

  let dteCount = 0;
  let solarCount = 0;
  let relayCount = 0;
  let blackoutCount = 0;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const tMs = baseMs + h * 3_600_000;
    const dtHours = (tMs - anchorMs) / 3_600_000;

    // 1. Solar propagation
    const sunAz = (((refSunAz - (360 / SYNODIC_H) * dtHours) % 360) + 360) % 360;
    const sunEl =
      refSunEl +
      1.54 * (Math.sin((2 * Math.PI * (h + 96)) / DRACONIC_H) - Math.sin((2 * Math.PI * (h - dtHours + 96)) / DRACONIC_H)) +
      0.35 * Math.cos((2 * Math.PI * dtHours) / SYNODIC_H);
    const sunHorizon =
      anchorResult && Math.abs(dtHours) < 1
        ? anchorResult.sun.horizon_deg
        : estimateSouthPoleHorizonDeg(lat, lon, sunAz);
    const isSunlit = sunEl > sunHorizon;

    // 2. Direct-to-Earth (DTE) propagation
    const earthAz =
      (((refEarthAz + 6.8 * (Math.sin((2 * Math.PI * h) / ANOMALISTIC_H) - Math.sin((2 * Math.PI * (h - dtHours)) / ANOMALISTIC_H))) %
        360) +
        360) %
      360;
    const earthEl =
      refEarthEl +
      6.68 * (Math.sin((2 * Math.PI * h) / DRACONIC_H) - Math.sin((2 * Math.PI * (h - dtHours)) / DRACONIC_H));
    const earthHorizon =
      anchorResult && anchorResult.earth.horizon_deg > 0 && Math.abs(dtHours) < 1
        ? anchorResult.earth.horizon_deg
        : estimateSouthPoleHorizonDeg(lat, lon, earthAz);
    const isDteClear = earthEl > earthHorizon + 0.15;

    // 3. Two-satellite LunaNet Relay Constellation (LCRNS-1 & Moonlight-1, 180° phased)
    const phase1 = (2 * Math.PI * dtHours) / RELAY_PERIOD_H;
    const el1 = refRelayEl * Math.cos(phase1) + 22.0 * Math.sin(phase1);
    const el2 = -refRelayEl * Math.cos(phase1) - 22.0 * Math.sin(phase1) + 14.0;
    const bestRelayEl = Math.max(el1, el2);
    const isRelayClear = bestRelayEl > 10.0;

    dteFlags[h] = isDteClear;
    solarFlags[h] = isSunlit;
    relayFlags[h] = isRelayClear;

    if (isDteClear) dteCount++;
    if (isSunlit) solarCount++;
    if (isRelayClear) relayCount++;
    if (!isDteClear && !isRelayClear) blackoutCount++;
  }

  const extractFirstWindow = (flags: boolean[], totalTrue: number): PredictionWindow | null => {
    let start = -1;
    for (let h = 0; h < flags.length; h++) {
      if (flags[h]) {
        start = h;
        break;
      }
    }
    if (start === -1) return null;
    let end = start;
    while (end + 1 < flags.length && flags[end + 1]) {
      end++;
    }
    const startDate = new Date(baseMs + start * 3_600_000);
    const endDate = new Date(baseMs + (end + 1) * 3_600_000);
    return {
      startHour: start,
      endHour: end + 1,
      startLabel: formatShortWindowUtc(startDate),
      endLabel: formatShortWindowUtc(endDate),
      durationHours: end - start + 1,
      availabilityPct: Number(((totalTrue / TOTAL_HOURS) * 100).toFixed(1)),
    };
  };

  return {
    dte: extractFirstWindow(dteFlags, dteCount),
    dtePct: Number(((dteCount / TOTAL_HOURS) * 100).toFixed(1)),
    solar: extractFirstWindow(solarFlags, solarCount),
    solarPct: Number(((solarCount / TOTAL_HOURS) * 100).toFixed(1)),
    relay: extractFirstWindow(relayFlags, relayCount),
    relayPct: Number(((relayCount / TOTAL_HOURS) * 100).toFixed(1)),
    blackoutHours: blackoutCount,
    blackoutPct: Number(((blackoutCount / TOTAL_HOURS) * 100).toFixed(1)),
  };
}

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
  if (s === 'DIRECT_DTE')      return '#00CC00';
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
  if (s === 'DIRECT_DTE')      return 'status-clear';
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

/**
 * Builds precise lunar circle polyline coordinates on Cesium.Ellipsoid.MOON.
 * Avoids entity.ellipse which defaults to Earth WGS84 and shifts polar coordinates.
 */
function buildLunarCirclePositions(
  centerLat: number,
  centerLon: number,
  radiusM: number,
  segments = 64,
): Cesium.Cartesian3[] {
  const center = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 0, Cesium.Ellipsoid.MOON);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center, Cesium.Ellipsoid.MOON);
  const pts: Cesium.Cartesian3[] = [];

  for (let i = 0; i <= segments; i++) {
    const theta = (i * 2 * Math.PI) / segments;
    const local = new Cesium.Cartesian3(
      radiusM * Math.cos(theta),
      radiusM * Math.sin(theta),
      0,
    );
    const pt = new Cesium.Cartesian3();
    Cesium.Matrix4.multiplyByPoint(enu, local, pt);
    const surfacePt = Cesium.Ellipsoid.MOON.scaleToGeodeticSurface(pt);
    if (surfacePt) {
      const elevated = Cesium.Cartesian3.multiplyByScalar(
        surfacePt,
        (MOON_RADIUS + 40) / MOON_RADIUS,
        new Cesium.Cartesian3(),
      );
      pts.push(elevated);
    } else {
      pts.push(pt);
    }
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

function addRayLabel(
  viewer: Cesium.Viewer,
  position: Cesium.Cartesian3,
  text: string,
  colorCss: string,
  pixelOffset: Cesium.Cartesian2 = new Cesium.Cartesian2(0, 0),
): Cesium.Entity {
  return viewer.entities.add({
    position,
    label: {
      text,
      font: 'bold 11px Georgia, serif',
      fillColor: Cesium.Color.fromCssColorString(colorCss),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.75),
      pixelOffset,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
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

    let labelText = `${Math.abs(lat)}°S`;
    let isArtemisZone = false;

    if (lat === -89) {
      labelText = '89°S (30 km)';
    } else if (lat === -88) {
      labelText = '88°S';
    } else if (lat === -87) {
      labelText = '87°S (91 km)';
    } else if (lat === -86) {
      labelText = '86°S';
    } else if (lat === -85) {
      labelText = '85°S · 152 km ARTEMIS ZONE';
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
  for (const c of IAU_CRATERS) {
    viewer.entities.add({
      name: `${c.name} Crater Rim`,
      polyline: {
        positions: buildLunarCirclePositions(c.lat, c.lon, c.radiusM, 64),
        width: 1.5,
        material: Cesium.Color.fromCssColorString('#999999'),
        arcType: Cesium.ArcType.NONE,
        clampToGround: false,
      },
    });

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

  const markerRef       = useRef<Cesium.Entity | null>(null);
  const rayEntitiesRef  = useRef<Cesium.Entity[]>([]);

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

  /* Live Clock State */
  const [liveClock, setLiveClock] = useState<string>(() => formatUtcClock(new Date()));

  /* UTC Time State */
  const [utcTime, setUtcTime] = useState<string>(TIME_START.toISOString());
  const [customDateInput, setCustomDateInput] = useState<string>(toDatetimeLocalString(TIME_START));

  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Ticking live UTC clock */
  useEffect(() => {
    const timer = setInterval(() => {
      setLiveClock(formatUtcClock(new Date()));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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

    const lunarImagery = new Cesium.UrlTemplateImageryProvider({
      url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
      tilingScheme: new Cesium.GeographicTilingScheme(),
      maximumLevel: 7,
      credit: 'NASA LRO WAC',
    });
    viewer.imageryLayers.addImageryProvider(lunarImagery);

    if (ionToken) {
      Cesium.Cesium3DTileset.fromIonAssetId(2684829).then((tileset) => {
        viewer.scene.primitives.add(tileset);
      }).catch(() => {/* no tileset, continue */});
    }

    addGraticule(viewer);
    addCraters(viewer);

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(0.0, -90.0, 420000, Cesium.Ellipsoid.MOON),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
    });

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

  /* ---- 30-Day Prediction Windows Forecast ---- */
  const forecast = useMemo(
    () => computeMissionForecast(lat, lon, utcTime, result),
    [lat, lon, utcTime, result],
  );

  const handleJumpToWindow = (startHour: number) => {
    setPlaying(false);
    const clampedHour = Math.max(0, Math.min(TOTAL_HOURS, startHour));
    setTimeHours(clampedHour);
    const targetDate = new Date(TIME_START.getTime() + clampedHour * 3_600_000);
    const targetIso = targetDate.toISOString();
    setUtcTime(targetIso);
    setCustomDateInput(toDatetimeLocalString(targetDate));
    fetchImmediate(lat, lon, band, targetIso);
  };

  /* ---- Update 3D overlays when result changes ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !result) return;

    if (markerRef.current) viewer.entities.remove(markerRef.current);
    rayEntitiesRef.current.forEach((e) => viewer.entities.remove(e));
    rayEntitiesRef.current = [];

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

    /* 1. Solar ray (#FFFF00) */
    const isShadow = result.sun.power_status === 'CRITICAL_SHADOW';
    const sunLen   = isShadow ? RAY_LENGTH * 0.35 : RAY_LENGTH;
    const sunEnd   = azElToCartesian(lat, lon, result.sun.azimuth_deg, result.sun.elevation_deg, sunLen);

    rayEntitiesRef.current.push(
      viewer.entities.add({
        polyline: {
          positions: [markerPos, sunEnd],
          width: isShadow ? 1.5 : 2.5,
          material: new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString('#FFFF00').withAlpha(isShadow ? 0.4 : 1.0),
          ),
          clampToGround: false,
        },
      }),
    );

    const sunMid = Cesium.Cartesian3.midpoint(markerPos, sunEnd, new Cesium.Cartesian3());
    const sunText = isShadow
      ? 'SOLAR RAY [SHADOWED]'
      : `SOLAR RAY (${result.sun.elevation_deg.toFixed(1)}°)`;
    rayEntitiesRef.current.push(
      addRayLabel(viewer, sunMid, sunText, '#FFFF00', new Cesium.Cartesian2(0, -12)),
    );

    /* 2. Comms rays */
    const comms = result.overall_comms;
    if (comms === 'DIRECT_DTE') {
      const earthEnd = azElToCartesian(lat, lon, result.earth.azimuth_deg, result.earth.elevation_deg, RAY_LENGTH);

      rayEntitiesRef.current.push(
        viewer.entities.add({
          polyline: {
            positions: [markerPos, earthEnd],
            width: 2.5,
            material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#00CC00')),
            clampToGround: false,
          },
        }),
      );

      const earthMid = Cesium.Cartesian3.midpoint(markerPos, earthEnd, new Cesium.Cartesian3());
      const earthText = `DIRECT-TO-EARTH (DTE ${result.earth.elevation_deg.toFixed(1)}°)`;
      rayEntitiesRef.current.push(
        addRayLabel(viewer, earthMid, earthText, '#00CC00', new Cesium.Cartesian2(0, 12)),
      );
    } else if (comms === 'RELAY_AVAILABLE') {
      const relayMidPt = azElToCartesian(lat, lon, result.relay.azimuth_deg, result.relay.elevation_deg, RAY_LENGTH * 0.5);
      const relayEndPt = azElToCartesian(lat, lon, result.relay.azimuth_deg, result.relay.elevation_deg + 10, RAY_LENGTH);

      rayEntitiesRef.current.push(
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

      rayEntitiesRef.current.push(
        viewer.entities.add({
          position: relayMidPt,
          point: {
            pixelSize: 8,
            color: Cesium.Color.fromCssColorString('#FFAA00'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `🛰 ${result.relay.node_name}`,
            font: 'bold 11px Georgia, serif',
            fillColor: Cesium.Color.fromCssColorString('#FFAA00'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.75),
            pixelOffset: new Cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );

      const seg1Mid = Cesium.Cartesian3.midpoint(markerPos, relayMidPt, new Cesium.Cartesian3());
      rayEntitiesRef.current.push(
        addRayLabel(viewer, seg1Mid, `UPLINK → ${result.relay.node_name}`, '#FFAA00', new Cesium.Cartesian2(0, -10)),
      );

      const seg2Mid = Cesium.Cartesian3.midpoint(relayMidPt, relayEndPt, new Cesium.Cartesian3());
      rayEntitiesRef.current.push(
        addRayLabel(viewer, seg2Mid, 'DOWNLINK → EARTH', '#FFAA00', new Cesium.Cartesian2(0, 10)),
      );
    } else {
      const blockedEnd = azElToCartesian(lat, lon, result.earth.azimuth_deg, result.earth.elevation_deg, RAY_LENGTH * 0.25);

      rayEntitiesRef.current.push(
        viewer.entities.add({
          polyline: {
            positions: [markerPos, blockedEnd],
            width: 2.5,
            material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#FF3333')),
            clampToGround: false,
          },
        }),
      );

      const blockedMid = Cesium.Cartesian3.midpoint(markerPos, blockedEnd, new Cesium.Cartesian3());
      rayEntitiesRef.current.push(
        addRayLabel(viewer, blockedMid, 'DTE BLOCKED (TERRAIN)', '#FF3333', new Cesium.Cartesian2(0, 10)),
      );
    }
  }, [result, lat, lon]);

  /* ---- Playback ---- */
  useEffect(() => {
    if (playing) {
      playIntervalRef.current = setInterval(() => {
        setTimeHours((h) => {
          const next = h + 1;
          if (next >= TOTAL_HOURS) {
            setPlaying(false);
            return TOTAL_HOURS;
          }
          const nextDate = new Date(TIME_START.getTime() + next * 3_600_000);
          const nextIso = nextDate.toISOString();
          setUtcTime(nextIso);
          setCustomDateInput(toDatetimeLocalString(nextDate));
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
    const newDate = new Date(TIME_START.getTime() + h * 3_600_000);
    const newIso = newDate.toISOString();
    setUtcTime(newIso);
    setCustomDateInput(toDatetimeLocalString(newDate));
  };

  const handleStepTime = (deltaHours: number) => {
    setPlaying(false);
    setTimeHours((h) => {
      const next = Math.max(0, Math.min(TOTAL_HOURS, h + deltaHours));
      const newDate = new Date(TIME_START.getTime() + next * 3_600_000);
      const newIso = newDate.toISOString();
      setUtcTime(newIso);
      setCustomDateInput(toDatetimeLocalString(newDate));
      return next;
    });
  };

  const handleNowUtc = () => {
    setPlaying(false);
    const now = new Date();
    const nowIso = now.toISOString();
    setUtcTime(nowIso);
    setCustomDateInput(toDatetimeLocalString(now));
    const diffHours = (now.getTime() - TIME_START.getTime()) / 3_600_000;
    if (diffHours >= 0 && diffHours <= TOTAL_HOURS) {
      setTimeHours(Math.round(diffHours));
    }
    fetchImmediate(lat, lon, band, nowIso);
  };

  const handleSetCustomUtc = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!customDateInput) return;
    const parseStr = customDateInput.endsWith('Z') ? customDateInput : customDateInput + 'Z';
    const parsedDate = new Date(parseStr);
    if (isNaN(parsedDate.getTime())) return;
    setPlaying(false);
    const newIso = parsedDate.toISOString();
    setUtcTime(newIso);
    const diffHours = (parsedDate.getTime() - TIME_START.getTime()) / 3_600_000;
    if (diffHours >= 0 && diffHours <= TOTAL_HOURS) {
      setTimeHours(Math.round(diffHours));
    }
    fetchImmediate(lat, lon, band, newIso);
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

  /* ---- Sanitize DTE telemetry fields when Earth is below geometric horizon ---- */
  const dteDisplay = useMemo(() => {
    if (!result) return null;
    const isZeroShortCircuit =
      result.earth.dte_status === 'BLOCKED' &&
      result.earth.horizon_deg === 0 &&
      result.earth.peak_distance_km === 0;

    const horizonText = isZeroShortCircuit
      ? `${fmt(estimateSouthPoleHorizonDeg(lat, lon, result.earth.azimuth_deg))}°`
      : `${fmt(result.earth.horizon_deg)}°`;

    const obstacleText =
      isZeroShortCircuit && result.earth.elevation_deg < 0
        ? 'GEOMETRIC HORIZON'
        : `${fmt(result.earth.peak_distance_km, 1)} km`;

    const isObstructed =
      result.earth.dte_status === 'BLOCKED' && result.earth.fresnel_clearance_m <= 0;

    const fresnelClearText = isObstructed
      ? 'OBSTRUCTED'
      : `${fmt(result.earth.fresnel_clearance_m, 1)} m`;

    const isFresnelOk =
      result.earth.dte_status === 'CLEAR' &&
      result.earth.fresnel_clear &&
      result.earth.fresnel_clearance_m >= result.earth.required_fresnel_m;

    return {
      horizonText,
      obstacleText,
      isObstructed,
      fresnelClearText,
      isFresnelOk,
    };
  }, [result, lat, lon]);

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

        {/* Top-Right Map Vector Legend */}
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

        {/* Header with Live UTC Clock, Mission Logo, & Pure Green GitHub Link */}
        <div className="panel-header">
          <div className="panel-header-content">
            <div className="panel-title">Lunar South Pole Navigator</div>
            <div className="panel-subtitle">NASA Space Apps Challenge — Landing Site Analysis</div>
            <div className="live-clock-badge">{liveClock}</div>
            {result && (
              <span className={`source-indicator ${result.source === 'LIVE' ? 'source-live' : 'source-offline'}`}>
                SOURCE: {result.source === 'LIVE' ? 'LIVE C++ ENGINE' : 'OFFLINE FALLBACK'}
              </span>
            )}
          </div>
          <div className="header-brand-col">
            <img
              src="/logo.png"
              alt="Mission Logo"
              className="mission-logo"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            <a
              href="https://github.com/Agavrile/lunar-navigator"
              target="_blank"
              rel="noopener noreferrer"
              className="github-link"
              title="View Source Repository on GitHub"
            >
              GITHUB
            </a>
          </div>
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

        {/* Time Scrubber, Precision Step Controls, NOW (UTC), & Custom UTC Picker */}
        <div className="panel-section">
          <div className="section-label">Libration &amp; Mission Time Control</div>
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
            <button
              type="button"
              className="time-step-btn now-btn"
              onClick={handleNowUtc}
              title="Set analysis to current real-world UTC"
            >
              NOW (UTC)
            </button>
          </div>

          {/* Custom UTC Date/Time Form */}
          <form className="custom-utc-form" onSubmit={handleSetCustomUtc}>
            <label className="coord-label" htmlFor="custom-utc-input">
              CUSTOM UTC DATE &amp; TIME (ANY EPOCH)
            </label>
            <div className="custom-utc-row">
              <input
                id="custom-utc-input"
                type="datetime-local"
                step="1"
                className="coord-input custom-utc-input"
                value={customDateInput}
                onChange={(e) => setCustomDateInput(e.target.value)}
              />
              <button type="submit" className="coord-apply-btn">
                SET UTC
              </button>
            </div>
          </form>
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
          {result && dteDisplay && (
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
                  <td>{dteDisplay.horizonText}</td>
                </tr>
                <tr>
                  <td>Obstacle Distance</td>
                  <td style={{ fontSize: dteDisplay.obstacleText === 'GEOMETRIC HORIZON' ? '9px' : '11px' }}>
                    {dteDisplay.obstacleText}
                  </td>
                </tr>
                <tr>
                  <td>60% Fresnel Clear</td>
                  <td className={dteDisplay.isObstructed ? 'status-critical' : undefined}>
                    {dteDisplay.fresnelClearText}
                  </td>
                </tr>
                <tr>
                  <td>Required Fresnel</td>
                  <td>{fmt(result.earth.required_fresnel_m, 1)} m</td>
                </tr>
                <tr>
                  <td>Fresnel OK</td>
                  <td className={dteDisplay.isFresnelOk ? 'status-clear' : 'status-critical'}>
                    {dteDisplay.isFresnelOk ? 'YES' : 'NO'}
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

        {/* 5. 30-Day Mission Prediction Windows */}
        <div className="panel-section">
          <div className="section-label">30-Day Mission Prediction Windows</div>
          <div className="forecast-list">
            {/* DTE Transmit Window */}
            <div className="forecast-row">
              <div className="forecast-row-top">
                <span className="forecast-title">DTE TRANSMIT TO EARTH</span>
                <span className={forecast.dte ? 'status-clear' : 'status-critical'}>
                  {forecast.dtePct}% (30D)
                </span>
              </div>
              <div className="forecast-row-bottom">
                {forecast.dte ? (
                  <>
                    <span className="forecast-window">
                      {forecast.dte.startLabel} → {forecast.dte.endLabel} UTC ({forecast.dte.durationHours}h)
                    </span>
                    <button
                      type="button"
                      className="jump-btn"
                      onClick={() => handleJumpToWindow(forecast.dte!.startHour)}
                      title="Jump timeline to DTE window start"
                    >
                      JUMP
                    </button>
                  </>
                ) : (
                  <span className="forecast-none">NONE IN 30D (0.0%)</span>
                )}
              </div>
            </div>

            {/* Solar Panel Charging Window */}
            <div className="forecast-row">
              <div className="forecast-row-top">
                <span className="forecast-title">SOLAR PANEL CHARGING</span>
                <span className={forecast.solar ? 'status-solar' : 'status-critical'}>
                  {forecast.solarPct}% (30D)
                </span>
              </div>
              <div className="forecast-row-bottom">
                {forecast.solar ? (
                  <>
                    <span className="forecast-window">
                      {forecast.solar.startLabel} → {forecast.solar.endLabel} UTC ({forecast.solar.durationHours}h)
                    </span>
                    <button
                      type="button"
                      className="jump-btn"
                      onClick={() => handleJumpToWindow(forecast.solar!.startHour)}
                      title="Jump timeline to Solar Charging window start"
                    >
                      JUMP
                    </button>
                  </>
                ) : (
                  <span className="forecast-none">NONE IN 30D (PSR SHADOW)</span>
                )}
              </div>
            </div>

            {/* Orbital Relay Window */}
            <div className="forecast-row">
              <div className="forecast-row-top">
                <span className="forecast-title">ORBITAL RELAY (LUNANET)</span>
                <span className={forecast.relay ? 'status-warn' : 'status-critical'}>
                  {forecast.relayPct}% (30D)
                </span>
              </div>
              <div className="forecast-row-bottom">
                {forecast.relay ? (
                  <>
                    <span className="forecast-window">
                      {forecast.relay.startLabel} → {forecast.relay.endLabel} UTC ({forecast.relay.durationHours}h)
                    </span>
                    <button
                      type="button"
                      className="jump-btn"
                      onClick={() => handleJumpToWindow(forecast.relay!.startHour)}
                      title="Jump timeline to Relay Pass start"
                    >
                      JUMP
                    </button>
                  </>
                ) : (
                  <span className="forecast-none">NONE IN 30D (0.0%)</span>
                )}
              </div>
            </div>

            {/* Comms Blackout Risk */}
            <div className="forecast-row forecast-row-last">
              <div className="forecast-row-top">
                <span className="forecast-title">COMMS BLACKOUT RISK</span>
                <span className={forecast.blackoutPct > 25 ? 'status-critical' : 'status-warn'}>
                  {forecast.blackoutHours}h / 720h ({forecast.blackoutPct}%)
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>{/* end control-panel */}
    </div>
  );
}