/* ============================================================
   API Client — Lunar Navigator
   POST https://lunar-api.andreos.org/api/v1/analyze
   Falls back to deterministic TypeScript calculator on error.
   ============================================================ */

export type FrequencyBand = 'S_BAND' | 'X_BAND' | 'KA_BAND';

export interface AnalyzeRequest {
  lat: number;
  lon: number;
  utc_time: string;
  frequency_band: FrequencyBand;
}

export type PowerStatus  = 'OPTIMAL' | 'LOW_POWER' | 'CRITICAL_SHADOW';
export type DteStatus    = 'CLEAR' | 'DIFFRACTION_WARNING' | 'BLOCKED';
export type OverallComms = 'DIRECT_DTE' | 'RELAY_AVAILABLE' | 'COMPLETE_BLACKOUT';

export interface AnalyzeResponse {
  source: 'LIVE' | 'OFFLINE FALLBACK';
  site_elevation_m: number;
  dem_loaded: boolean;
  ephemeris_source: string;

  overall_comms: OverallComms;

  sun: {
    azimuth_deg: number;
    elevation_deg: number;
    horizon_deg: number;
    net_deg: number;
    power_status: PowerStatus;
  };

  earth: {
    azimuth_deg: number;
    elevation_deg: number;
    horizon_deg: number;
    peak_distance_km: number;
    fresnel_clearance_m: number;
    required_fresnel_m: number;
    fresnel_clear: boolean;
    dte_status: DteStatus;
  };

  relay: {
    available: boolean;
    node_name: string;
    azimuth_deg: number;
    elevation_deg: number;
  };
}

/* ---- Deterministic offline fallback ---- */

function toRad(deg: number): number { return (deg * Math.PI) / 180; }
function toDeg(rad: number): number { return (rad * 180) / Math.PI; }

/** Rough lunar south-pole terrain horizon elevation (degrees) based on lat/lon. */
function terrainHorizon(lat: number, lon: number): number {
  // Polar regions have high terrain blockage; approximate by proximity to pole
  const poleProx = Math.abs(lat) - 85;
  const base = Math.max(0, 4 + poleProx * 1.5 + Math.sin(toRad(lon * 3)) * 2);
  return parseFloat(base.toFixed(2));
}

/** Approximate geocentric Earth elevation from south pole site */
function earthElevation(lat: number, lon: number, utcMs: number): number {
  // Earth libration cycles: ~27.3 days, rough approximation
  const librationPhase = (utcMs / (27.32 * 86400e3)) * 2 * Math.PI;
  const baseElev = -1.5 + (lat + 90) * 0.08 + Math.sin(librationPhase) * 5.5;
  const lonEffect = Math.cos(toRad(lon)) * 2.5;
  return parseFloat((baseElev + lonEffect).toFixed(2));
}

/** Approximate Sun elevation at lunar south pole */
function sunElevation(lat: number, _lon: number, utcMs: number): number {
  // Solar synodic month ~29.53 days
  const solarPhase = (utcMs / (29.53 * 86400e3)) * 2 * Math.PI;
  // South pole sun stays near horizon, varies ±1.5°
  const baseSun = -0.3 + Math.sin(solarPhase) * 1.8 + (lat + 90) * 0.05;
  return parseFloat(baseSun.toFixed(2));
}

function fresnelRadius(distKm: number, freqGhz: number): number {
  const d = distKm * 1000; // metres
  const lambda = 3e8 / (freqGhz * 1e9);
  return Math.sqrt(0.6 * lambda * d);
}

function bandFreqGhz(band: FrequencyBand): number {
  if (band === 'S_BAND')  return 2.2;
  if (band === 'X_BAND')  return 8.4;
  return 26.0;
}

function computeFallback(req: AnalyzeRequest): AnalyzeResponse {
  const utcMs = new Date(req.utc_time).getTime();
  const { lat, lon, frequency_band } = req;

  const earthElev  = earthElevation(lat, lon, utcMs);
  const sunElev    = sunElevation(lat, lon, utcMs);
  const terrHor    = terrainHorizon(lat, lon);
  const terrHorEarth = terrainHorizon(lat, (lon + 90) % 360);

  const earthAz = toDeg(Math.atan2(Math.sin(toRad(lon)), Math.cos(toRad(lat))));
  const sunAz   = (earthAz + 180) % 360;

  const peakDistKm  = 384400 * Math.cos(toRad(lat));
  const freqGhz     = bandFreqGhz(frequency_band);
  const fresnelClear = fresnelRadius(peakDistKm, freqGhz);
  const fresnelReq   = fresnelClear * 0.6;
  const obstacleM    = terrHorEarth * peakDistKm * 1000 * Math.PI / 180;

  const dteStatus: DteStatus =
    earthElev > terrHorEarth + 1.5 ? 'CLEAR' :
    earthElev > terrHorEarth       ? 'DIFFRACTION_WARNING' : 'BLOCKED';

  const sunNetDeg     = sunElev - terrHor;
  const powerStatus: PowerStatus =
    sunNetDeg > 1.0  ? 'OPTIMAL' :
    sunNetDeg > -1.0 ? 'LOW_POWER' : 'CRITICAL_SHADOW';

  const relayAvail   = dteStatus === 'BLOCKED';
  const relayElev    = relayAvail ? 15.5 + Math.sin(utcMs / 3600e3) * 8 : 0;
  const relayAz      = (sunAz + 45) % 360;
  const relayNode    = lon > 180 ? 'Moonlight-1' : 'LCRNS-1';

  const overallComms: OverallComms =
    dteStatus !== 'BLOCKED'  ? 'DIRECT_DTE' :
    relayAvail               ? 'RELAY_AVAILABLE' : 'COMPLETE_BLACKOUT';

  return {
    source: 'OFFLINE FALLBACK',
    site_elevation_m: -2341 + (lat + 89) * 120 + Math.sin(toRad(lon)) * 400,
    dem_loaded: false,
    ephemeris_source: 'TypeScript Fallback',
    overall_comms: overallComms,
    sun: {
      azimuth_deg:   parseFloat(sunAz.toFixed(2)),
      elevation_deg: sunElev,
      horizon_deg:   terrHor,
      net_deg:       parseFloat(sunNetDeg.toFixed(2)),
      power_status:  powerStatus,
    },
    earth: {
      azimuth_deg:       parseFloat(((earthAz + 360) % 360).toFixed(2)),
      elevation_deg:     earthElev,
      horizon_deg:       terrHorEarth,
      peak_distance_km:  parseFloat(peakDistKm.toFixed(1)),
      fresnel_clearance_m: parseFloat(fresnelClear.toFixed(1)),
      required_fresnel_m:  parseFloat(fresnelReq.toFixed(1)),
      fresnel_clear:     obstacleM < fresnelClear,
      dte_status:        dteStatus,
    },
    relay: {
      available:    relayAvail,
      node_name:    relayAvail ? relayNode : '—',
      azimuth_deg:  parseFloat(relayAz.toFixed(2)),
      elevation_deg: parseFloat(relayElev.toFixed(2)),
    },
  };
}

/* ---- Debounce helper ---- */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function analyzeDebounced(
  req: AnalyzeRequest,
  callback: (res: AnalyzeResponse) => void,
  delay = 250,
): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    analyzeRequest(req).then(callback).catch(console.error);
  }, delay);
}

export async function analyzeRequest(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch('https://lunar-api.andreos.org/api/v1/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as AnalyzeResponse;
    data.source = 'LIVE';
    return data;
  } catch {
    clearTimeout(timeoutId);
    return computeFallback(req);
  }
}
