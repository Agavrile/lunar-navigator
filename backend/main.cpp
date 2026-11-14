#include "crow_all.h"
#include <nlohmann/json.hpp>

#include "gdal_parser.h"
#include "jpl_ephemeris.h"
#include "radio_comms.h"

#include <iostream>
#include <string>

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

static void apply_cors_headers(crow::response& res) {
    res.set_header("Access-Control-Allow-Origin",  "*");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type");
}

static void set_json_content_type(crow::response& res) {
    res.set_header("Content-Type", "application/json");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

int main() {
    // -----------------------------------------------------------------------
    // Instantiate shared engine objects exactly once so the GeoTIFF DEM and
    // the ephemeris client stay resident across all HTTP requests.
    // -----------------------------------------------------------------------
    GdalParser     gdal;        // Reads DEM_PATH env → "/data/lunar_dem.tif"
    JplEphemeris   jpl;
    RadioCommsEngine radio(gdal, jpl);

    std::cout << "[LunarAPI] DEM status : "
              << (gdal.isLoaded() ? "loaded ✓" : "not loaded (fallback mode)") << std::endl;
    std::cout << "[LunarAPI] Listening  : port 9091" << std::endl;

    crow::SimpleApp app;

    // -----------------------------------------------------------------------
    // GET / — health ping (minimal)
    // -----------------------------------------------------------------------
    CROW_ROUTE(app, "/").methods(crow::HTTPMethod::GET)
    ([&gdal](const crow::request& /*req*/) {
        crow::response res(200);
        apply_cors_headers(res);
        set_json_content_type(res);
        nlohmann::json body;
        body["status"]     = "online";
        body["dem_loaded"] = gdal.isLoaded();
        res.body = body.dump();
        return res;
    });

    // -----------------------------------------------------------------------
    // GET /health — explicit health check
    // -----------------------------------------------------------------------
    CROW_ROUTE(app, "/health").methods(crow::HTTPMethod::GET)
    ([&gdal](const crow::request& /*req*/) {
        crow::response res(200);
        apply_cors_headers(res);
        set_json_content_type(res);
        nlohmann::json body;
        body["status"]     = "online";
        body["dem_loaded"] = gdal.isLoaded();
        res.body = body.dump();
        return res;
    });

    // -----------------------------------------------------------------------
    // OPTIONS /api/v1/analyze — CORS preflight
    // -----------------------------------------------------------------------
    CROW_ROUTE(app, "/api/v1/analyze").methods(crow::HTTPMethod::OPTIONS)
    ([](const crow::request& /*req*/) {
        crow::response res(200);
        apply_cors_headers(res);
        return res;
    });

    // -----------------------------------------------------------------------
    // POST /api/v1/analyze — primary RF link budget analysis endpoint
    // -----------------------------------------------------------------------
    CROW_ROUTE(app, "/api/v1/analyze").methods(crow::HTTPMethod::POST)
    ([&radio, &gdal](const crow::request& req) {
        crow::response res;
        apply_cors_headers(res);
        set_json_content_type(res);

        // --- Parse JSON payload ------------------------------------------
        auto body = crow::json::load(req.body);
        if (!body) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = "Invalid JSON payload";
            res.body = err.dump();
            return res;
        }

        // --- Validate required fields ------------------------------------
        if (!body.has("lat") || !body.has("lon") ||
            !body.has("utc_time") || !body.has("frequency_band")) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = "Missing required fields: lat (double), lon (double), "
                           "utc_time (string), frequency_band (string)";
            res.body = err.dump();
            return res;
        }

        // --- Validate field types ----------------------------------------
        try {
            if (body["lat"].t()            != crow::json::type::Number ||
                body["lon"].t()            != crow::json::type::Number ||
                body["utc_time"].t()       != crow::json::type::String ||
                body["frequency_band"].t() != crow::json::type::String)
            {
                res.code = 400;
                crow::json::wvalue err;
                err["error"] = "Invalid field types: expected lat (double), lon (double), "
                               "utc_time (string), frequency_band (string)";
                res.body = err.dump();
                return res;
            }
        } catch (const std::exception& e) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = std::string("Error checking field types: ") + e.what();
            res.body = err.dump();
            return res;
        }

        // --- Extract parameters ------------------------------------------
        double      lat            = body["lat"].d();
        double      lon            = body["lon"].d();
        std::string utc_time       = std::string(body["utc_time"].s());
        std::string frequency_band = std::string(body["frequency_band"].s());

        // --- Validate coordinate ranges ----------------------------------
        if (lat < -90.0 || lat > 90.0) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = "lat out of range [-90, 90]";
            res.body = err.dump();
            return res;
        }
        if (lon < -180.0 || lon > 360.0) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = "lon out of range [-180, 360]";
            res.body = err.dump();
            return res;
        }

        // --- Invoke RadioCommsEngine -------------------------------------
        try {
            nlohmann::json analysis = radio.analyzeSite(lat, lon, utc_time, frequency_band);
            res.code = 200;
            res.body = analysis.dump();
        } catch (const std::exception& e) {
            res.code = 500;
            crow::json::wvalue err;
            err["error"] = std::string("Analysis engine error: ") + e.what();
            res.body = err.dump();
        }

        return res;
    });

    // -----------------------------------------------------------------------
    // Start multithreaded Crow server on port 9091
    // -----------------------------------------------------------------------
    app.port(9091).multithreaded().run();

    return 0;
}
