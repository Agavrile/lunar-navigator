#pragma once

#include "gdal_parser.h"
#include "jpl_ephemeris.h"
#include <nlohmann/json.hpp>
#include <string>

/**
 * @brief Physics Agent: Radio Communications Engine (Sprint 4)
 *
 * Integrates GDAL terrain ray-tracing, NASA JPL Horizons ephemeris,
 * 60% First Fresnel Zone knife-edge diffraction, solar power threshold
 * classification, and LunaNet orbital relay availability into a single
 * deterministic RF link budget analysis engine.
 *
 * Thread-safety: analyzeSite() is re-entrant provided GdalParser and
 * JplEphemeris are themselves thread-safe (GdalParser uses a mutex;
 * JplEphemeris is stateless).
 */
class RadioCommsEngine {
public:
    /**
     * @brief Construct the engine, binding it to existing parser/ephemeris instances.
     * @param gdal   Reference to an already-constructed GdalParser (DEM stays loaded).
     * @param jpl    Reference to an already-constructed JplEphemeris (stateless client).
     */
    RadioCommsEngine(GdalParser& gdal, JplEphemeris& jpl);

    ~RadioCommsEngine() = default;

    // Non-copyable, non-movable (holds references to external state)
    RadioCommsEngine(const RadioCommsEngine&)            = delete;
    RadioCommsEngine& operator=(const RadioCommsEngine&) = delete;

    /**
     * @brief Full RF link budget analysis for a lunar surface site.
     *
     * @param lat            Observer selenographic latitude  [-90, +90] degrees
     * @param lon            Observer selenographic longitude [-180, +180] degrees
     * @param utc_time       UTC timestamp (ISO-8601 or "YYYY-MM-DD HH:MM:SS")
     * @param frequency_band "S-BAND" | "X-BAND" | "KA-BAND"  (default X-BAND)
     * @return nlohmann::json object matching the Sprint 4 schema
     */
    nlohmann::json analyzeSite(double lat, double lon,
                               const std::string& utc_time,
                               const std::string& frequency_band) const;

private:
    GdalParser&   m_gdal;
    JplEphemeris& m_jpl;

    // Lunar relay satellite orbital parameters
    static constexpr double RELAY_SMA_KM    = 6100.0;    // Semi-major axis from Moon centre (km)
    static constexpr double RELAY_PERIOD_S  = 43200.0;   // 12-hour orbital period in seconds
    static constexpr double LUNAR_RADIUS_KM = 1737.4;    // R_Moon (km)
    static constexpr double LUNAR_RADIUS_M  = 1737400.0; // R_Moon (m)

    /**
     * @brief Maps a band label to carrier frequency in GHz.
     * Unknown labels default to X-BAND (8.4 GHz).
     */
    static double bandToFreqGHz(const std::string& band);

    /**
     * @brief Compute selenocentric Cartesian position of a polar-elliptical
     *        relay satellite given its epoch-zero mean anomaly offset.
     *
     * Orbit: circular polar (inc = 90°), radius = RELAY_SMA_KM.
     * Phase convention: LCRNS-1 at M0 = 0 rad; Moonlight-1 at M0 = π rad.
     *
     * @param jd         Julian Date of the observation epoch
     * @param phase_rad  Initial mean anomaly offset in radians
     * @param out_x/y/z  Selenocentric Cartesian coordinates (km) on output
     */
    static void relaySelenoCentric(double jd, double phase_rad,
                                   double& out_x, double& out_y, double& out_z);

    /**
     * @brief Project selenocentric target (Tx,Ty,Tz) onto the observer's
     *        topocentric horizon frame, returning azimuth & elevation.
     */
    static void topocentricAzEl(double lat, double lon, double site_elev_m,
                                double Tx, double Ty, double Tz,
                                double& out_az, double& out_el);

    /**
     * @brief Returns true when the relay satellite is geometrically occulted
     *        behind the Moon as seen from Earth (i.e. its selenocentric
     *        position falls inside the lunar shadow cone toward Earth).
     *
     * Earth centre is at ~384400 km along the sub-Earth selenographic direction.
     * We use the sub-Earth point from the Earth SkyPosition to reconstruct a
     * unit vector and test the relay against the lunar limb.
     *
     * @param Rx/Ry/Rz  Relay selenocentric position (km)
     * @param earth_az  Sub-Earth azimuth  (degrees) at observer site
     * @param earth_el  Sub-Earth elevation (degrees) at observer site
     * @param lat/lon/site_elev_m  Observer position on Moon
     */
    static bool relayOcculted(double Rx, double Ry, double Rz,
                               double earth_az, double earth_el,
                               double lat, double lon, double site_elev_m);
};

// Backwards-compatibility alias
using RadioComms = RadioCommsEngine;
