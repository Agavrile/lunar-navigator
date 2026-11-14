#pragma once

#include <string>
#include <vector>
#include <mutex>

// Forward declarations of GDAL / OGR internal structures to minimize namespace pollution
class GDALDataset;
class GDALRasterBand;
class OGRSpatialReference;
class OGRCoordinateTransformation;

/**
 * @brief Represents the result of a horizon ray-tracing scan along a given azimuth.
 */
struct HorizonResult {
    double max_angle_deg{0.0};      ///< Maximum apparent terrain elevation angle in degrees
    double peak_distance_km{0.0};   ///< Distance to the limiting terrain peak in kilometers
};

/**
 * @brief Topography Engine: High-performance GDAL South Polar DEM Parser & Ray Tracer.
 *
 * Implements bilinear DEM sampling and spherical horizon ray-tracing preserving
 * the native lunar radius (R_Moon = 1737400.0 m) without WGS84 distortion.
 */
class GdalParser {
public:
    using HorizonResult = ::HorizonResult;

    static constexpr double LUNAR_RADIUS_METERS = 1737400.0;

    /**
     * @brief Construct a GdalParser instance.
     * @param dem_path Path to GeoTIFF DEM. If empty, falls back to DEM_PATH env or "/data/lunar_dem.tif".
     */
    explicit GdalParser(const std::string& dem_path = "");

    /**
     * @brief Destructor releasing GDAL dataset and coordinate transformation resources cleanly.
     */
    ~GdalParser();

    // Disable copy semantics to prevent duplicate handle releases
    GdalParser(const GdalParser&) = delete;
    GdalParser& operator=(const GdalParser&) = delete;

    // Enable move semantics
    GdalParser(GdalParser&& other) noexcept;
    GdalParser& operator=(GdalParser&& other) noexcept;

    /**
     * @brief Checks if the DEM dataset was loaded successfully.
     */
    bool isLoaded() const;

    /**
     * @brief Computes surface elevation in meters at the given lunar coordinates.
     * @param lat Latitude in degrees [-90.0, 90.0]
     * @param lon Longitude in degrees (supports [-180.0, 180.0] and [0.0, 360.0])
     * @return Surface elevation in meters via 2x2 bilinear interpolation; 0.0 if out of bounds or NoData.
     */
    double getElevationMeters(double lat, double lon) const;

    /**
     * @brief Traces a ray outward along a specific azimuth to determine the apparent terrain horizon angle.
     * @param lat Observer latitude in degrees
     * @param lon Observer longitude in degrees
     * @param azimuth_deg Scan azimuth (0° = North, 90° = East, 180° = South, 270° = West)
     * @param max_dist_km Maximum scan distance in kilometers (default 50.0 km)
     * @param step_m Stepping interval in meters along great-circle arc (default 100.0 m)
     * @return HorizonResult containing max_angle_deg and peak_distance_km
     */
    HorizonResult computeHorizonAngleDeg(double lat, double lon, double azimuth_deg,
                                         double max_dist_km = 50.0,
                                         double step_m = 100.0) const;

    // Metadata accessors
    int getRasterWidth() const { return m_rasterXSize; }
    int getRasterHeight() const { return m_rasterYSize; }
    const double* getGeoTransform() const { return m_geoTransform; }
    const double* getInvGeoTransform() const { return m_invGeoTransform; }
    double getNoDataValue(bool* hasNoData = nullptr) const {
        if (hasNoData) *hasNoData = m_hasNoData;
        return m_noDataValue;
    }
    const std::string& getDemPath() const { return m_demPath; }

private:
    void cleanup();

    std::string m_demPath;
    GDALDataset* m_dataset = nullptr;
    GDALRasterBand* m_band = nullptr;
    int m_rasterXSize = 0;
    int m_rasterYSize = 0;
    double m_geoTransform[6]{0.0};
    double m_invGeoTransform[6]{0.0};
    bool m_hasGeoTransform = false;
    double m_noDataValue = -9999.0;
    bool m_hasNoData = false;

    OGRSpatialReference* m_poProjCS = nullptr;
    OGRSpatialReference* m_poGeogCS = nullptr;
    OGRCoordinateTransformation* m_poCoordTransform = nullptr;

    mutable std::mutex m_mutex;
};

// Backwards-compatible alias for Sprint 1 stub compatibility
using GDALParser = GdalParser;
