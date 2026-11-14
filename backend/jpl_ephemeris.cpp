#include "jpl_ephemeris.h"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <sstream>
#include <iomanip>
#include <chrono>
#include <cmath>
#include <algorithm>
#include <mutex>
#include <vector>
#include <cstdio>
#include <cstring>

namespace {

// Lunar physical and orbital constants
constexpr double LUNAR_RADIUS_KM = 1737.4;             // Lunar sphere radius: 1737400.0 m
constexpr double PI = 3.14159265358979323846;
constexpr double DEG2RAD = PI / 180.0;
constexpr double RAD2DEG = 180.0 / PI;
constexpr double LUNAR_EQUATOR_INCLINATION_DEG = 1.54242; // Inclination of Moon's equator to ecliptic (I)
constexpr double DIST_SUN_KM = 149597870.7;             // 1 Astronomical Unit (km)

// Global curl initialization safety
static std::once_flag s_curl_init_flag;
static void ensureCurlGlobalInit() {
    std::call_once(s_curl_init_flag, []() {
        curl_global_init(CURL_GLOBAL_ALL);
    });
}

// Libcurl response write callback
static size_t curlWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t total_bytes = size * nmemb;
    auto* buffer = static_cast<std::string*>(userp);
    if (buffer) {
        buffer->append(static_cast<char*>(contents), total_bytes);
    }
    return total_bytes;
}

// Normalizes an angle into [0, 360) degrees
static double normalize360(double deg) {
    deg = std::fmod(deg, 360.0);
    if (deg < 0.0) deg += 360.0;
    return deg;
}

// Normalizes an angle into [-180, +180) degrees
static double normalize180(double deg) {
    deg = std::fmod(deg + 180.0, 360.0);
    if (deg < 0.0) deg += 360.0;
    return deg - 180.0;
}

// Advances a broken-down Gregorian calendar date/time by exactly 1 minute
static void addOneMinute(int& y, int& m, int& d, int& hr, int& min) {
    min++;
    if (min >= 60) {
        min = 0;
        hr++;
        if (hr >= 24) {
            hr = 0;
            d++;
            int days_in_month[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
            bool is_leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
            if (is_leap) days_in_month[1] = 29;
            if (d > days_in_month[m - 1]) {
                d = 1;
                m++;
                if (m > 12) {
                    m = 1;
                    y++;
                }
            }
        }
    }
}

// Parses an ISO-8601 or standard datetime string into calendar components
static bool parseUtcComponents(const std::string& utc_time,
                               int& year, int& month, int& day,
                               int& hour, int& minute, double& second) {
    year = 2000; month = 1; day = 1;
    hour = 0; minute = 0; second = 0.0;

    if (utc_time.empty()) return false;

    int y = 0, m = 0, d = 0, hr = 0, min = 0;
    double sec = 0.0;

    // Format: YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD HH:MM:SS (with optional decimals/Z)
    int matched = std::sscanf(utc_time.c_str(), "%d-%d-%d%*c%d:%d:%lf", &y, &m, &d, &hr, &min, &sec);
    if (matched >= 5) {
        year = y; month = m; day = d; hour = hr; minute = min; second = sec;
        return true;
    }

    // Format: YYYY-MM-DDTHH:MM or YYYY-MM-DD HH:MM
    matched = std::sscanf(utc_time.c_str(), "%d-%d-%d%*c%d:%d", &y, &m, &d, &hr, &min);
    if (matched >= 5) {
        year = y; month = m; day = d; hour = hr; minute = min; second = 0.0;
        return true;
    }

    // Format: YYYY-MM-DD
    matched = std::sscanf(utc_time.c_str(), "%d-%d-%d", &y, &m, &d);
    if (matched >= 3) {
        year = y; month = m; day = d; hour = 0; minute = 0; second = 0.0;
        return true;
    }

    return false;
}

// URL-encodes a string using libcurl
static std::string curlEscape(CURL* curl, const std::string& input) {
    if (!curl) return input;
    char* escaped = curl_easy_escape(curl, input.c_str(), static_cast<int>(input.length()));
    if (!escaped) return input;
    std::string result(escaped);
    curl_free(escaped);
    return result;
}

// Projects a 3D selenocentric target vector onto the local topocentric horizon plane
static void projectTopocentric(double lat, double lon, double alt_km,
                               double Tx, double Ty, double Tz,
                               double& out_azi, double& out_elev) {
    double phi = lat * DEG2RAD;
    double lambda = lon * DEG2RAD;
    double r_obs = LUNAR_RADIUS_KM + alt_km;

    double cos_phi = std::cos(phi);
    double sin_phi = std::sin(phi);
    double cos_lam = std::cos(lambda);
    double sin_lam = std::sin(lambda);

    // Observer position on lunar sphere
    double Ox = r_obs * cos_phi * cos_lam;
    double Oy = r_obs * cos_phi * sin_lam;
    double Oz = r_obs * sin_phi;

    // Vector from observer to target
    double Vx = Tx - Ox;
    double Vy = Ty - Oy;
    double Vz = Tz - Oz;

    // Local topocentric orthonormal basis:
    // Up: radial outward along local surface normal
    double u_up_x = cos_phi * cos_lam;
    double u_up_y = cos_phi * sin_lam;
    double u_up_z = sin_phi;

    // East: tangent to parallel in direction of increasing longitude
    double u_east_x = -sin_lam;
    double u_east_y = cos_lam;
    double u_east_z = 0.0;

    // North: tangent to meridian towards lunar North Pole
    double u_north_x = -sin_phi * cos_lam;
    double u_north_y = -sin_phi * sin_lam;
    double u_north_z = cos_phi;

    // Project V onto topocentric basis
    double v_up = Vx * u_up_x + Vy * u_up_y + Vz * u_up_z;
    double v_east = Vx * u_east_x + Vy * u_east_y + Vz * u_east_z;
    double v_north = Vx * u_north_x + Vy * u_north_y + Vz * u_north_z;

    double horiz_range = std::hypot(v_east, v_north);
    out_elev = std::atan2(v_up, horiz_range) * RAD2DEG;
    out_azi = normalize360(std::atan2(v_east, v_north) * RAD2DEG);
}

} // anonymous namespace

double JplEphemeris::parseUtcTimeToJulianDate(const std::string& utc_time) {
    int year = 2000, month = 1, day = 1, hour = 0, minute = 0;
    double second = 0.0;

    if (!parseUtcComponents(utc_time, year, month, day, hour, minute, second)) {
        // Fallback to current system UTC time if unparseable
        auto now = std::chrono::system_clock::now();
        std::time_t tt = std::chrono::system_clock::to_time_t(now);
        std::tm tm_utc = {};
#if defined(_WIN32)
        gmtime_s(&tm_utc, &tt);
#else
        gmtime_r(&tt, &tm_utc);
#endif
        year = tm_utc.tm_year + 1900;
        month = tm_utc.tm_mon + 1;
        day = tm_utc.tm_mday;
        hour = tm_utc.tm_hour;
        minute = tm_utc.tm_min;
        second = static_cast<double>(tm_utc.tm_sec);
    }

    int y = year;
    int m = month;
    if (m <= 2) {
        y -= 1;
        m += 12;
    }

    int A = y / 100;
    int B = 2 - A + (A / 4);
    double day_fraction = static_cast<double>(day) + (hour / 24.0) + (minute / 1440.0) + (second / 86400.0);
    double jd = std::floor(365.25 * (y + 4716)) + std::floor(30.6001 * (m + 1)) + day_fraction + B - 1524.5;
    return jd;
}

bool JplEphemeris::queryHorizonsBody(const std::string& command,
                                     double lat, double lon, double alt_km,
                                     const std::string& utc_time,
                                     SkyPosition& out_pos) {
    ensureCurlGlobalInit();

    CURL* curl = curl_easy_init();
    if (!curl) return false;

    // Parse time to format START_TIME and STOP_TIME (+1 minute)
    int year = 2000, month = 1, day = 1, hour = 0, minute = 0;
    double second = 0.0;
    if (!parseUtcComponents(utc_time, year, month, day, hour, minute, second)) {
        auto now = std::chrono::system_clock::now();
        std::time_t tt = std::chrono::system_clock::to_time_t(now);
        std::tm tm_utc = {};
#if defined(_WIN32)
        gmtime_s(&tm_utc, &tt);
#else
        gmtime_r(&tt, &tm_utc);
#endif
        year = tm_utc.tm_year + 1900;
        month = tm_utc.tm_mon + 1;
        day = tm_utc.tm_mday;
        hour = tm_utc.tm_hour;
        minute = tm_utc.tm_min;
        second = static_cast<double>(tm_utc.tm_sec);
    }

    char start_time_str[64];
    std::snprintf(start_time_str, sizeof(start_time_str), "%04d-%02d-%02d %02d:%02d", year, month, day, hour, minute);

    int stop_year = year, stop_month = month, stop_day = day, stop_hour = hour, stop_min = minute;
    addOneMinute(stop_year, stop_month, stop_day, stop_hour, stop_min);
    char stop_time_str[64];
    std::snprintf(stop_time_str, sizeof(stop_time_str), "%04d-%02d-%02d %02d:%02d", stop_year, stop_month, stop_day, stop_hour, stop_min);

    std::ostringstream site_coord_ss;
    site_coord_ss << std::fixed << std::setprecision(6) << lon << "," << lat << "," << alt_km;

    // Construct JPL Horizons REST API URL
    std::ostringstream url_builder;
    url_builder << "https://ssd.jpl.nasa.gov/api/horizons.api?format=json"
                << "&COMMAND=" << curlEscape(curl, "'" + command + "'")
                << "&OBJ_DATA=" << curlEscape(curl, "'NO'")
                << "&MAKE_EPHEM=" << curlEscape(curl, "'YES'")
                << "&EPHEM_TYPE=" << curlEscape(curl, "'OBSERVER'")
                << "&CENTER=" << curlEscape(curl, "'coord@301'")
                << "&COORD_TYPE=" << curlEscape(curl, "'GEODETIC'")
                << "&SITE_COORD=" << curlEscape(curl, "'" + site_coord_ss.str() + "'")
                << "&QUANTITIES=" << curlEscape(curl, "'4'")
                << "&START_TIME=" << curlEscape(curl, "'" + std::string(start_time_str) + "'")
                << "&STOP_TIME=" << curlEscape(curl, "'" + std::string(stop_time_str) + "'")
                << "&STEP_SIZE=" << curlEscape(curl, "'1m'");

    std::string full_url = url_builder.str();
    std::string response_buffer;

    // Configure libcurl options (enforcing strict 4-second timeout)
    curl_easy_setopt(curl, CURLOPT_URL, full_url.c_str());
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 4L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 4L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "LunarNavigator/1.0 (NASA JPL Horizons Ephemeris Client)");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_buffer);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        curl_easy_cleanup(curl);
        return false;
    }

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_easy_cleanup(curl);

    if (http_code != 200 || response_buffer.empty()) {
        return false;
    }

    // Parse JSON result with nlohmann::json
    try {
        auto json_data = nlohmann::json::parse(response_buffer);
        if (!json_data.contains("result") || !json_data["result"].is_string()) {
            return false;
        }

        std::string result_text = json_data["result"].get<std::string>();

        // Locate ephemeris data block between $$SOE and $$EOE markers
        size_t soe_pos = result_text.find("$$SOE");
        size_t eoe_pos = result_text.find("$$EOE", soe_pos);
        if (soe_pos == std::string::npos || eoe_pos == std::string::npos || eoe_pos <= soe_pos) {
            return false;
        }

        std::string ephem_block = result_text.substr(soe_pos + 5, eoe_pos - (soe_pos + 5));
        std::istringstream stream(ephem_block);
        std::string line;

        while (std::getline(stream, line)) {
            // Trim leading/trailing whitespace
            size_t first = line.find_first_not_of(" \t\r\n");
            if (first == std::string::npos) continue;

            std::istringstream line_stream(line);
            std::vector<std::string> tokens;
            std::string tok;
            while (line_stream >> tok) {
                tokens.push_back(tok);
            }

            // Horizons row structure for QUANTITIES='4':
            // Date (e.g. 2026-Nov-14), Time (e.g. 12:00), optional solar/interference flag(s) ('*', 'i', etc.),
            // followed by Azi_(a-app) and Elev_(a-app).
            if (tokens.size() >= 4) {
                try {
                    double azi = std::stod(tokens[tokens.size() - 2]);
                    double elev = std::stod(tokens.back());

                    out_pos.azimuth_deg = normalize360(azi);
                    out_pos.elevation_deg = elev;
                    out_pos.from_live_api = true;
                    return true;
                } catch (...) {
                    return false;
                }
            }
        }

        return false;
    } catch (...) {
        return false;
    }
}

SkyPosition JplEphemeris::computeAnalyticalSun(double lat, double lon, double alt_km, double jd) {
    double T = (jd - 2451545.0) / 36525.0;

    // Fundamental astronomical arguments (Meeus Astronomical Algorithms Ch 47 & 53)
    // Lunar mean longitude L_prime (27.32166-day sidereal cycle)
    double L_prime = normalize360(218.3164477 + 481267.88128 * T);
    // Sun's mean anomaly M
    double M = normalize360(357.5291092 + 35999.05029 * T);
    // Longitude of lunar ascending node Omega (Cassini precession of spin axis)
    double Omega = normalize360(125.04452 - 1934.136261 * T);
    double I = LUNAR_EQUATOR_INCLINATION_DEG;

    // Sun's true ecliptic longitude L_sun
    double C_sun = (1.914602 - 0.004817 * T) * std::sin(M * DEG2RAD)
                 + (0.019993 - 0.000101 * T) * std::sin(2.0 * M * DEG2RAD);
    double L_sun = normalize360(280.46646 + 36000.76983 * T + C_sun);

    // Ecliptic direction from Moon to Sun
    double lam_sun_from_moon = normalize360(L_sun + 180.0);
    double W_sun = normalize360(lam_sun_from_moon - Omega);

    // Coordinate transformation to lunar equatorial frame
    double x_s = std::cos(W_sun * DEG2RAD);
    double y_s = std::sin(W_sun * DEG2RAD) * std::cos(I * DEG2RAD);
    double z_s = -std::sin(W_sun * DEG2RAD) * std::sin(I * DEG2RAD);

    double alpha_s = std::atan2(y_s, x_s) * RAD2DEG;
    double l_sun = normalize180(alpha_s - (L_prime - Omega));
    double b_sun = std::asin(std::clamp(z_s, -1.0, 1.0)) * RAD2DEG;

    // Selenocentric Cartesian coordinates of Sun (1 AU distance)
    double Sx = DIST_SUN_KM * std::cos(b_sun * DEG2RAD) * std::cos(l_sun * DEG2RAD);
    double Sy = DIST_SUN_KM * std::cos(b_sun * DEG2RAD) * std::sin(l_sun * DEG2RAD);
    double Sz = DIST_SUN_KM * std::sin(b_sun * DEG2RAD);

    // Project onto topocentric horizon frame at observer location
    double azi = 0.0, elev = 0.0;
    projectTopocentric(lat, lon, alt_km, Sx, Sy, Sz, azi, elev);

    SkyPosition pos;
    pos.azimuth_deg = azi;
    pos.elevation_deg = elev;
    pos.from_live_api = false;
    return pos;
}

SkyPosition JplEphemeris::computeAnalyticalEarth(double lat, double lon, double alt_km, double jd) {
    double T = (jd - 2451545.0) / 36525.0;

    // Fundamental astronomical arguments (Meeus Ch 47 & 53)
    double L_prime = normalize360(218.3164477 + 481267.88128 * T); // 27.32166-day lunar sidereal cycle
    double D = normalize360(297.8501921 + 445267.11140 * T);       // 29.53059-day synodic solar cycle
    double M = normalize360(357.5291092 + 35999.05029 * T);       // Sun mean anomaly
    double M_prime = normalize360(134.9633964 + 477198.86751 * T); // 27.55455-day anomalistic libration cycle
    double F = normalize360(93.2720950 + 483202.01753 * T);       // 27.21222-day draconic cycle
    double Omega = normalize360(125.04452 - 1934.136261 * T);     // Ascending node
    double I = LUNAR_EQUATOR_INCLINATION_DEG;

    // Geocentric lunar perturbations in longitude (degrees)
    double sigma_l = 6.288774 * std::sin(M_prime * DEG2RAD)
                   + 1.274027 * std::sin((2.0 * D - M_prime) * DEG2RAD)
                   + 0.658309 * std::sin(2.0 * D * DEG2RAD)
                   + 0.213618 * std::sin(2.0 * M_prime * DEG2RAD)
                   - 0.185116 * std::sin(M * DEG2RAD)
                   - 0.114332 * std::sin(2.0 * F * DEG2RAD);
    double lam_moon = normalize360(L_prime + sigma_l);

    // Geocentric lunar perturbations in latitude (degrees)
    double sigma_b = 5.128153 * std::sin(F * DEG2RAD)
                   + 0.280606 * std::sin((M_prime + F) * DEG2RAD)
                   + 0.277693 * std::sin((M_prime - F) * DEG2RAD)
                   + 0.173237 * std::sin((2.0 * D - F) * DEG2RAD);
    double beta_moon = sigma_b;

    // Distance from Moon to Earth (km)
    double dist_earth = 385000.56 - 20905.355 * std::cos(M_prime * DEG2RAD)
                                  - 3699.111 * std::cos((2.0 * D - M_prime) * DEG2RAD)
                                  - 2955.968 * std::cos(2.0 * D * DEG2RAD);

    // Selenographic coordinates of Earth center (lunar libration wobble)
    double W_m = normalize360(lam_moon - Omega);
    double sin_W = std::sin(W_m * DEG2RAD);
    double cos_W = std::cos(W_m * DEG2RAD);
    double sin_b = std::sin(beta_moon * DEG2RAD);
    double cos_b = std::cos(beta_moon * DEG2RAD);
    double sin_I = std::sin(I * DEG2RAD);
    double cos_I = std::cos(I * DEG2RAD);

    double A_m = std::atan2(sin_W * cos_b * cos_I - sin_b * sin_I, cos_W * cos_b) * RAD2DEG;
    double l_earth = normalize180(A_m - F);
    double sin_b_earth = -sin_W * cos_b * sin_I - sin_b * cos_I;
    double b_earth = std::asin(std::clamp(sin_b_earth, -1.0, 1.0)) * RAD2DEG;

    // Selenocentric Cartesian coordinates of Earth center
    double Ex = dist_earth * std::cos(b_earth * DEG2RAD) * std::cos(l_earth * DEG2RAD);
    double Ey = dist_earth * std::cos(b_earth * DEG2RAD) * std::sin(l_earth * DEG2RAD);
    double Ez = dist_earth * std::sin(b_earth * DEG2RAD);

    // Project onto topocentric horizon frame at observer location
    double azi = 0.0, elev = 0.0;
    projectTopocentric(lat, lon, alt_km, Ex, Ey, Ez, azi, elev);

    SkyPosition pos;
    pos.azimuth_deg = azi;
    pos.elevation_deg = elev;
    pos.from_live_api = false;
    return pos;
}

CelestialPositions JplEphemeris::getPositions(double lat, double lon, double alt_km, const std::string& utc_time) {
    CelestialPositions positions;
    double jd = parseUtcTimeToJulianDate(utc_time);

    // 1. Live JPL Horizons query for Sun (COMMAND='10') with 4-second timeout
    bool sun_live_ok = queryHorizonsBody("10", lat, lon, alt_km, utc_time, positions.sun);
    if (!sun_live_ok) {
        // Fallback to deterministic analytical Sun model
        positions.sun = computeAnalyticalSun(lat, lon, alt_km, jd);
        positions.sun.from_live_api = false;
    }

    // 2. Live JPL Horizons query for Earth (COMMAND='399') with 4-second timeout
    bool earth_live_ok = queryHorizonsBody("399", lat, lon, alt_km, utc_time, positions.earth);
    if (!earth_live_ok) {
        // Fallback to deterministic analytical Earth libration model
        positions.earth = computeAnalyticalEarth(lat, lon, alt_km, jd);
        positions.earth.from_live_api = false;
    }

    return positions;
}
