#include "radio_comms.h"

#include "gdal_parser.h"
#include "jpl_ephemeris.h"

#include <cmath>
#include <algorithm>
#include <string>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

RadioCommsEngine::RadioCommsEngine(GdalParser& gdal, JplEphemeris& jpl)
    : m_gdal(gdal), m_jpl(jpl)
{}

// ---------------------------------------------------------------------------
// Static helpers
// ---------------------------------------------------------------------------

double RadioCommsEngine::bandToFreqGHz(const std::string& band)
{
    if (band == "S-BAND")  return 2.2;
    if (band == "KA-BAND") return 26.0;
    // X-BAND is the default for unrecognised / empty strings
    return 8.4;
}

void RadioCommsEngine::relaySelenoCentric(double jd, double phase_rad,
                                          double& out_x, double& out_y, double& out_z)
{
    // JD of arbitrary epoch reference (J2000.0 noon)
    constexpr double JD_J2000 = 2451545.0;

    // Elapsed seconds since J2000.0
    double elapsed_s = (jd - JD_J2000) * 86400.0;

    // Mean angular velocity (rad/s)
    double n = (2.0 * M_PI) / RELAY_PERIOD_S;

    // Current mean anomaly (circular orbit → true anomaly = mean anomaly)
    double M = std::fmod(n * elapsed_s + phase_rad, 2.0 * M_PI);
    if (M < 0.0) M += 2.0 * M_PI;

    // Polar orbit (inclination = 90°) in the selenocentric equatorial frame.
    // The ascending node is fixed at longitude 0° for a deterministic
    // but physics-plausible model.
    //   x = a * cos(M)   (along equatorial x-axis at node)
    //   y = 0            (node at zero longitude)
    //   z = a * sin(M)   (polar component)
    out_x = RELAY_SMA_KM * std::cos(M);
    out_y = 0.0;
    out_z = RELAY_SMA_KM * std::sin(M);
}

void RadioCommsEngine::topocentricAzEl(double lat, double lon, double site_elev_m,
                                       double Tx, double Ty, double Tz,
                                       double& out_az, double& out_el)
{
    constexpr double DEG2RAD = M_PI / 180.0;
    constexpr double RAD2DEG = 180.0 / M_PI;

    double phi    = lat * DEG2RAD;
    double lambda = lon * DEG2RAD;
    double r_obs  = LUNAR_RADIUS_KM + site_elev_m / 1000.0;  // km

    double cos_phi = std::cos(phi);
    double sin_phi = std::sin(phi);
    double cos_lam = std::cos(lambda);
    double sin_lam = std::sin(lambda);

    // Observer selenocentric Cartesian position (km)
    double Ox = r_obs * cos_phi * cos_lam;
    double Oy = r_obs * cos_phi * sin_lam;
    double Oz = r_obs * sin_phi;

    // Vector from observer to target
    double Vx = Tx - Ox;
    double Vy = Ty - Oy;
    double Vz = Tz - Oz;

    // Local orthonormal topocentric basis
    // Up: radial outward (surface normal)
    double u_up_x = cos_phi * cos_lam;
    double u_up_y = cos_phi * sin_lam;
    double u_up_z = sin_phi;

    // East: tangent to parallel (increasing longitude)
    double u_east_x = -sin_lam;
    double u_east_y =  cos_lam;
    double u_east_z =  0.0;

    // North: tangent to meridian (toward lunar north pole)
    double u_north_x = -sin_phi * cos_lam;
    double u_north_y = -sin_phi * sin_lam;
    double u_north_z =  cos_phi;

    // Project onto basis
    double v_up    = Vx * u_up_x    + Vy * u_up_y    + Vz * u_up_z;
    double v_east  = Vx * u_east_x  + Vy * u_east_y  + Vz * u_east_z;
    double v_north = Vx * u_north_x + Vy * u_north_y + Vz * u_north_z;

    double horiz_range = std::hypot(v_east, v_north);
    out_el = std::atan2(v_up, horiz_range) * RAD2DEG;

    // atan2(east, north) gives clockwise bearing from North
    double az = std::atan2(v_east, v_north) * RAD2DEG;
    az = std::fmod(az, 360.0);
    if (az < 0.0) az += 360.0;
    out_az = az;
}

bool RadioCommsEngine::relayOcculted(double Rx, double Ry, double Rz,
                                     double /*earth_az*/, double /*earth_el*/,
                                     double /*lat*/, double /*lon*/, double /*site_elev_m*/)
{
    // Geometric Moon occultation: the relay is behind the Moon from Earth's
    // perspective when the angle between the relay position vector and the
    // Earth direction (anti-sub-Earth) is less than the lunar limb half-angle.
    //
    // Earth is approximately at distance ~384400 km from Moon centre, in the
    // direction anti-parallel to the Moon's sub-Earth selenocentric vector.
    // For a deterministic model we use a fixed Earth direction
    // (mean sub-Earth point ≈ selenographic origin direction) and test whether
    // the relay position falls inside the lunar disk cone.
    //
    // Occultation condition:
    //   angle(relay, toward_Earth) < arcsin(R_Moon / |relay|)
    // i.e. the relay is behind the Moon as seen from Earth.

    // For the deterministic model the Earth direction unit vector is simply
    // chosen as the direction that minimises the sub-lunar longitude ambiguity:
    // Earth is in the direction of the sub-Earth libration centre, which on
    // average is very close to the negative-X selenocentric axis (the leading
    // hemisphere faces away from Earth for a tidally locked body where +X
    // points toward Earth by convention).
    //
    // Here we follow the jpl_ephemeris.cpp convention where +X in
    // selenocentric equatorial frame points toward Earth at mean libration.
    // A unit vector toward Earth: (1, 0, 0).

    constexpr double EARTH_DIR_X = 1.0, EARTH_DIR_Y = 0.0, EARTH_DIR_Z = 0.0;

    double r_relay = std::sqrt(Rx * Rx + Ry * Ry + Rz * Rz);
    if (r_relay < 1e-9) return true;  // degenerate: treat as occulted

    // Dot product of relay unit vector with Earth direction unit vector
    double dot = (Rx * EARTH_DIR_X + Ry * EARTH_DIR_Y + Rz * EARTH_DIR_Z) / r_relay;

    // Angle between relay and Earth direction
    double angle_to_earth = std::acos(std::clamp(dot, -1.0, 1.0));

    // Half-angle of the lunar disk as seen from relay position
    double lunar_half_angle = std::asin(std::clamp(LUNAR_RADIUS_KM / r_relay, 0.0, 1.0));

    // The relay is occulted when it is on the far side of the Moon from Earth
    // AND within the shadow cone.  "Far side" means the angle to Earth is
    // greater than 90°, and in addition the Moon's limb subtends enough to
    // block the line of sight.
    if (angle_to_earth > (M_PI / 2.0 + lunar_half_angle)) {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Primary analysis method
// ---------------------------------------------------------------------------

nlohmann::json RadioCommsEngine::analyzeSite(double lat, double lon,
                                              const std::string& utc_time,
                                              const std::string& frequency_band) const
{
    using json = nlohmann::json;

    // -----------------------------------------------------------------------
    // 1. Frequency band mapping
    // -----------------------------------------------------------------------
    const double freq_ghz = bandToFreqGHz(frequency_band);

    // -----------------------------------------------------------------------
    // 2. Terrain elevation & datum normalisation
    // -----------------------------------------------------------------------
    const double raw_elev_m = m_gdal.getElevationMeters(lat, lon);

    // LOLA GeoTIFF values may contain the full lunar radius in unscaled tiles.
    // Subtract sphere radius only when the raw value exceeds 1 Mm.
    const double site_elev_m = (raw_elev_m > 1000000.0)
                                ? (raw_elev_m - LUNAR_RADIUS_M)
                                : raw_elev_m;

    // -----------------------------------------------------------------------
    // 3. Ephemeris query (live JPL Horizons → analytical fallback)
    // -----------------------------------------------------------------------
    // altitude argument expected in km
    CelestialPositions sky = m_jpl.getPositions(lat, lon, site_elev_m / 1000.0, utc_time);

    const bool from_live = sky.sun.from_live_api || sky.earth.from_live_api;
    const std::string ephemeris_source = from_live ? "JPL_HORIZONS" : "ANALYTICAL_FALLBACK";

    // -----------------------------------------------------------------------
    // 4. Solar power state (horizon-aware)
    // -----------------------------------------------------------------------
    HorizonResult sun_hor = m_gdal.computeHorizonAngleDeg(lat, lon, sky.sun.azimuth_deg);
    const double net_sun_deg = sky.sun.elevation_deg - sun_hor.max_angle_deg;

    std::string power_status;
    if (net_sun_deg >= 5.0) {
        power_status = "OPTIMAL";
    } else if (net_sun_deg >= 1.5) {
        power_status = "LOW_POWER";
    } else {
        power_status = "CRITICAL_SHADOW";
    }

    // -----------------------------------------------------------------------
    // 5. Direct-to-Earth (DTE) link & 60 % First Fresnel Zone clearance
    // -----------------------------------------------------------------------
    HorizonResult earth_hor = m_gdal.computeHorizonAngleDeg(lat, lon, sky.earth.azimuth_deg);

    // Distance partitioning for Fresnel computation
    const double d1_km = std::max(0.1, earth_hor.peak_distance_km);
    const double d2_km = 384400.0 - d1_km;    // Earth-Moon mean distance (km)

    // 1st Fresnel Zone radius at the obstacle (metres)
    // F1 = 17.32 * sqrt((d1 * d2) / (f_GHz * (d1 + d2)))  [km inputs, m output]
    const double f1_m = 17.32 * std::sqrt((d1_km * d2_km) / (freq_ghz * (d1_km + d2_km)));
    const double req_clearance_m = 0.6 * f1_m;

    std::string dte_status;
    bool fresnel_clear   = false;
    double clearance_m   = 0.0;

    if (sky.earth.elevation_deg <= earth_hor.max_angle_deg) {
        // Earth is geometrically blocked by terrain
        dte_status   = "BLOCKED";
        fresnel_clear = false;
        clearance_m  = 0.0;
    } else {
        // Physical clearance above the terrain obstruction tip (metres)
        clearance_m = std::tan((sky.earth.elevation_deg - earth_hor.max_angle_deg)
                               * M_PI / 180.0)
                      * (d1_km * 1000.0);

        if (clearance_m < req_clearance_m) {
            dte_status    = "DIFFRACTION_WARNING";
            fresnel_clear = false;
        } else {
            dte_status    = "CLEAR";
            fresnel_clear = true;
        }
    }

    // -----------------------------------------------------------------------
    // 6. Orbital relay evaluator (LCRNS-1 & Moonlight-1)
    // -----------------------------------------------------------------------
    const double jd = JplEphemeris::parseUtcTimeToJulianDate(utc_time);

    struct RelayInfo {
        const char* name;
        double      phase_rad;   // initial mean anomaly offset
    };
    const RelayInfo relays[2] = {
        { "LCRNS-1",     0.0  },
        { "Moonlight-1", M_PI }
    };

    // Track the best (highest elevation) visible relay
    bool   relay_available    = false;
    std::string relay_name    = "LCRNS-1";   // reported even when unavailable
    double relay_az           = 0.0;
    double relay_el           = -90.0;

    for (const auto& sat : relays) {
        double Sx = 0.0, Sy = 0.0, Sz = 0.0;
        relaySelenoCentric(jd, sat.phase_rad, Sx, Sy, Sz);

        // Geometric check: satellite must not be below lunar surface
        double r_sat = std::sqrt(Sx * Sx + Sy * Sy + Sz * Sz);
        if (r_sat < LUNAR_RADIUS_KM) continue;

        // Topocentric azimuth & elevation at observer
        double sat_az = 0.0, sat_el = 0.0;
        topocentricAzEl(lat, lon, site_elev_m, Sx, Sy, Sz, sat_az, sat_el);

        // Terrain horizon along satellite azimuth
        HorizonResult rel_hor = m_gdal.computeHorizonAngleDeg(lat, lon, sat_az);

        // Above local horizon AND not occulted behind Moon from Earth's perspective
        if (sat_el > rel_hor.max_angle_deg
            && !relayOcculted(Sx, Sy, Sz,
                              sky.earth.azimuth_deg, sky.earth.elevation_deg,
                              lat, lon, site_elev_m))
        {
            // Select highest-elevation visible relay
            if (!relay_available || sat_el > relay_el) {
                relay_available = true;
                relay_name      = sat.name;
                relay_az        = sat_az;
                relay_el        = sat_el;
            }
        }
    }

    // If no relay is visible, default report name stays LCRNS-1 (per spec)
    if (!relay_available) {
        // Compute LCRNS-1 position for reporting even when unavailable
        double Sx = 0.0, Sy = 0.0, Sz = 0.0;
        relaySelenoCentric(jd, 0.0, Sx, Sy, Sz);
        topocentricAzEl(lat, lon, site_elev_m, Sx, Sy, Sz, relay_az, relay_el);
        relay_name = "LCRNS-1";
    }

    // -----------------------------------------------------------------------
    // 7. Overall comms classification
    // -----------------------------------------------------------------------
    std::string overall_comms;
    if (dte_status == "CLEAR" || dte_status == "DIFFRACTION_WARNING") {
        overall_comms = "DIRECT_DTE";
    } else if (relay_available) {
        overall_comms = "RELAY_AVAILABLE";
    } else {
        overall_comms = "COMPLETE_BLACKOUT";
    }

    // -----------------------------------------------------------------------
    // 8. Build output JSON (matches Sprint 4 schema exactly)
    // -----------------------------------------------------------------------
    json result;

    result["site_elevation_m"]  = std::round(site_elev_m * 100.0) / 100.0;
    result["dem_loaded"]        = m_gdal.isLoaded();
    result["ephemeris_source"]  = ephemeris_source;

    result["sun"]["azimuth_deg"]   = sky.sun.azimuth_deg;
    result["sun"]["elevation_deg"] = sky.sun.elevation_deg;
    result["sun"]["horizon_deg"]   = sun_hor.max_angle_deg;
    result["sun"]["net_deg"]       = net_sun_deg;
    result["sun"]["power_status"]  = power_status;

    result["earth"]["azimuth_deg"]         = sky.earth.azimuth_deg;
    result["earth"]["elevation_deg"]       = sky.earth.elevation_deg;
    result["earth"]["horizon_deg"]         = earth_hor.max_angle_deg;
    result["earth"]["peak_distance_km"]    = earth_hor.peak_distance_km;
    result["earth"]["fresnel_clearance_m"] = std::round(clearance_m * 10.0) / 10.0;
    result["earth"]["required_fresnel_m"]  = std::round(req_clearance_m * 10.0) / 10.0;
    result["earth"]["fresnel_clear"]       = fresnel_clear;
    result["earth"]["dte_status"]          = dte_status;

    result["relay"]["available"]    = relay_available;
    result["relay"]["node_name"]    = relay_name;
    result["relay"]["azimuth_deg"]  = relay_az;
    result["relay"]["elevation_deg"]= relay_el;

    result["overall_comms"] = overall_comms;

    return result;
}
