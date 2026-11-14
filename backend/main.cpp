#include "crow_all.h"
#include <nlohmann/json.hpp>

#include "gdal_parser.h"
#include "jpl_ephemeris.h"
#include "radio_comms.h"

#include <iostream>
#include <string>

/**
 * @brief Attach standardized CORS headers to HTTP response.
 */
static void apply_cors_headers(crow::response& res) {
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type");
}

int main() {
    crow::SimpleApp app;

    // Explicit OPTIONS preflight route for CORS compliance
    CROW_ROUTE(app, "/api/v1/analyze").methods(crow::HTTPMethod::OPTIONS)
    ([](const crow::request& /*req*/) {
        crow::response res(200);
        apply_cors_headers(res);
        return res;
    });

    // Primary POST analysis endpoint
    CROW_ROUTE(app, "/api/v1/analyze").methods(crow::HTTPMethod::POST)
    ([](const crow::request& req) {
        crow::response res;
        apply_cors_headers(res);
        res.set_header("Content-Type", "application/json");

        // Safely parse JSON payload
        auto body = crow::json::load(req.body);
        if (!body) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = "Invalid JSON payload";
            res.body = err.dump();
            return res;
        }

        // Validate required fields existence
        if (!body.has("lat") || !body.has("lon") || !body.has("utc_time") || !body.has("frequency_band")) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = "Missing required fields: lat (double), lon (double), utc_time (string), frequency_band (string)";
            res.body = err.dump();
            return res;
        }

        // Validate field data types
        try {
            if (body["lat"].t() != crow::json::type::Number ||
                body["lon"].t() != crow::json::type::Number ||
                body["utc_time"].t() != crow::json::type::String ||
                body["frequency_band"].t() != crow::json::type::String) {
                res.code = 400;
                crow::json::wvalue err;
                err["error"] = "Invalid field types: expected lat (double), lon (double), utc_time (string), frequency_band (string)";
                res.body = err.dump();
                return res;
            }

            double lat = body["lat"].d();
            double lon = body["lon"].d();
            std::string utc_time = std::string(body["utc_time"].s());
            std::string frequency_band = std::string(body["frequency_band"].s());

            // Suppress unused variable warnings in Sprint 1 mock phase
            (void)lat;
            (void)lon;
            (void)utc_time;
            (void)frequency_band;
        } catch (const std::exception& e) {
            res.code = 400;
            crow::json::wvalue err;
            err["error"] = std::string("Error parsing parameters: ") + e.what();
            res.body = err.dump();
            return res;
        }

        // Hardcoded mock response for Sprint 1 frontend integration
        crow::json::wvalue mock_response;

        // Sun ephemeris & net elevation
        mock_response["sun"]["elevation_deg"] = 2.1;
        mock_response["sun"]["horizon_deg"] = 0.5;
        mock_response["sun"]["net_deg"] = 1.6;
        mock_response["sun"]["power_status"] = "LOW_POWER";

        // Earth line-of-sight & DTE communications
        mock_response["earth"]["elevation_deg"] = 4.3;
        mock_response["earth"]["horizon_deg"] = 2.1;
        mock_response["earth"]["fresnel_clear"] = true;
        mock_response["earth"]["dte_status"] = "CLEAR";

        // Relay satellite communications
        mock_response["relay"]["available"] = true;
        mock_response["relay"]["node_name"] = "LCRNS-1";
        mock_response["relay"]["elevation_deg"] = 38.4;

        // Overall communications status
        mock_response["overall_comms"] = "DIRECT_DTE";

        res.code = 200;
        res.body = mock_response.dump();
        return res;
    });

    // Start Crow server on port 9091 (multithreaded)
    app.port(9091).multithreaded().run();

    return 0;
}
