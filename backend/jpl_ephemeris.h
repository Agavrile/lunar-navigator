#pragma once

#include <string>

/**
 * @brief Topocentric celestial position in local lunar horizon coordinates.
 */
struct SkyPosition {
    double azimuth_deg;     ///< Azimuth in degrees clockwise from North [0, 360)
    double elevation_deg;   ///< Elevation in degrees above the local tangent plane [-90, +90]
    bool from_live_api;     ///< True if resolved from NASA JPL Horizons live REST API, false if analytical fallback
};

/**
 * @brief Combined topocentric celestial positions for Sun and Earth.
 */
struct CelestialPositions {
    SkyPosition sun;        ///< Apparent topocentric Sun position
    SkyPosition earth;      ///< Apparent topocentric Earth position
};

/**
 * @brief NASA JPL Horizons REST API client with deterministic analytical fallback.
 * 
 * Provides high-precision topocentric ephemeris calculations for lunar surface observers,
 * accounting for lunar sphere radius (1737.4 km), optical and physical libration wobble,
 * and the synodic solar cycle.
 */
class JplEphemeris {
public:
    JplEphemeris() = default;
    ~JplEphemeris() = default;

    /**
     * @brief Computes topocentric Sun and Earth azimuth/elevation for a lunar surface location.
     * 
     * Queries NASA JPL Horizons REST API (4-second timeout).
     * If live query fails, times out, or returns an unparseable response,
     * computes deterministic analytical positions based on Meeus lunar theory.
     * 
     * @param lat Observer selenographic latitude in degrees [-90, +90]
     * @param lon Observer selenographic longitude in degrees [-180, +180] or [0, 360]
     * @param alt_km Observer altitude above the lunar reference sphere in km
     * @param utc_time UTC timestamp string (e.g. "2026-11-14T12:00:00Z" or "2026-11-14 12:00")
     * @return CelestialPositions struct containing Sun and Earth SkyPositions
     */
    CelestialPositions getPositions(double lat, double lon, double alt_km, const std::string& utc_time);

    /**
     * @brief Computes analytical topocentric Sun position based on Julian Date and lunar synodic cycle.
     */
    static SkyPosition computeAnalyticalSun(double lat, double lon, double alt_km, double jd);

    /**
     * @brief Computes analytical topocentric Earth position accounting for lunar libration wobble.
     */
    static SkyPosition computeAnalyticalEarth(double lat, double lon, double alt_km, double jd);

    /**
     * @brief Parses an ISO-8601 or standard UTC string into a Julian Date.
     */
    static double parseUtcTimeToJulianDate(const std::string& utc_time);

private:
    /**
     * @brief Queries JPL Horizons REST API for a specific target body.
     * 
     * @param command JPL target body ID ('10' for Sun, '399' for Earth)
     * @param lat Observer selenographic latitude in degrees
     * @param lon Observer selenographic longitude in degrees
     * @param alt_km Observer altitude in km
     * @param utc_time UTC time string
     * @param out_pos Output SkyPosition struct if query succeeds
     * @return true if successfully retrieved and parsed from JPL Horizons, false otherwise
     */
    static bool queryHorizonsBody(const std::string& command,
                                  double lat, double lon, double alt_km,
                                  const std::string& utc_time,
                                  SkyPosition& out_pos);
};

// Backward-compatibility alias
using JPLEphemeris = JplEphemeris;
