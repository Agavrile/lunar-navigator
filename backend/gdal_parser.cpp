#include "gdal_parser.h"

#include <gdal_priv.h>
#include <cpl_conv.h>
#include <ogr_spatialref.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <iomanip>
#include <algorithm>
#include <limits>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

GdalParser::GdalParser(const std::string& dem_path) {
    // 1. Register all available GDAL raster drivers
    GDALAllRegister();

    // 2. Resolve target DEM file path:
    //    Explicit parameter > DEM_PATH environment variable > Default "/data/lunar_dem.tif"
    if (!dem_path.empty()) {
        m_demPath = dem_path;
    } else {
        const char* env_path = std::getenv("DEM_PATH");
        if (env_path && std::strlen(env_path) > 0) {
            m_demPath = env_path;
        } else {
            m_demPath = "/data/lunar_dem.tif";
        }
    }

    // 3. Open the dataset in read-only mode
    m_dataset = static_cast<GDALDataset*>(GDALOpen(m_demPath.c_str(), GA_ReadOnly));
    if (!m_dataset) {
        // Dataset could not be opened (e.g. offline or unmounted volume); safe fallback active
        return;
    }

    // 4. Cache raster dimensions & primary elevation band
    m_rasterXSize = m_dataset->GetRasterXSize();
    m_rasterYSize = m_dataset->GetRasterYSize();
    m_band = m_dataset->GetRasterBand(1);
    if (m_band) {
        int pbSuccess = 0;
        m_noDataValue = m_band->GetNoDataValue(&pbSuccess);
        m_hasNoData = (pbSuccess != 0);
    }

    // 5. Compute forward and inverse GeoTransform matrices
    if (m_dataset->GetGeoTransform(m_geoTransform) == CE_None) {
        if (GDALInvGeoTransform(m_geoTransform, m_invGeoTransform)) {
            m_hasGeoTransform = true;
        }
    }

    // 6. Setup lunar spatial references preserving R_Moon = 1737400.0 m without WGS84 distortion
    const OGRSpatialReference* datasetSRS = m_dataset->GetSpatialRef();
    if (datasetSRS) {
        m_poProjCS = datasetSRS->Clone();
        m_poProjCS->SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);

        // Clone the underlying lunar geographic coordinate system (IAU Moon datum/spheroid)
        m_poGeogCS = m_poProjCS->CloneGeogCS();
        if (m_poGeogCS) {
            m_poGeogCS->SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
            m_poCoordTransform = OGRCreateCoordinateTransformation(m_poGeogCS, m_poProjCS);
        }
    } else {
        // Fallback for older GDAL / WKT projection strings
        const char* projRef = m_dataset->GetProjectionRef();
        if (projRef && std::strlen(projRef) > 0) {
            m_poProjCS = new OGRSpatialReference();
            if (m_poProjCS->importFromWkt(projRef) == OGRERR_NONE) {
                m_poProjCS->SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
                m_poGeogCS = m_poProjCS->CloneGeogCS();
                if (m_poGeogCS) {
                    m_poGeogCS->SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
                    m_poCoordTransform = OGRCreateCoordinateTransformation(m_poGeogCS, m_poProjCS);
                }
            } else {
                OGRSpatialReference::DestroySpatialReference(m_poProjCS);
                m_poProjCS = nullptr;
            }
        }
    }
}

GdalParser::~GdalParser() {
    cleanup();
}

void GdalParser::cleanup() {
    if (m_poCoordTransform) {
        OGRCoordinateTransformation::DestroyCT(m_poCoordTransform);
        m_poCoordTransform = nullptr;
    }
    if (m_poGeogCS) {
        OGRSpatialReference::DestroySpatialReference(m_poGeogCS);
        m_poGeogCS = nullptr;
    }
    if (m_poProjCS) {
        OGRSpatialReference::DestroySpatialReference(m_poProjCS);
        m_poProjCS = nullptr;
    }
    if (m_dataset) {
        GDALClose(m_dataset);
        m_dataset = nullptr;
        m_band = nullptr;
    }
    m_hasGeoTransform = false;
    m_rasterXSize = 0;
    m_rasterYSize = 0;
}

GdalParser::GdalParser(GdalParser&& other) noexcept {
    *this = std::move(other);
}

GdalParser& GdalParser::operator=(GdalParser&& other) noexcept {
    if (this != &other) {
        cleanup();

        m_demPath = std::move(other.m_demPath);
        m_dataset = other.m_dataset;
        m_band = other.m_band;
        m_rasterXSize = other.m_rasterXSize;
        m_rasterYSize = other.m_rasterYSize;
        std::copy(other.m_geoTransform, other.m_geoTransform + 6, m_geoTransform);
        std::copy(other.m_invGeoTransform, other.m_invGeoTransform + 6, m_invGeoTransform);
        m_hasGeoTransform = other.m_hasGeoTransform;
        m_noDataValue = other.m_noDataValue;
        m_hasNoData = other.m_hasNoData;
        m_poProjCS = other.m_poProjCS;
        m_poGeogCS = other.m_poGeogCS;
        m_poCoordTransform = other.m_poCoordTransform;

        other.m_dataset = nullptr;
        other.m_band = nullptr;
        other.m_poProjCS = nullptr;
        other.m_poGeogCS = nullptr;
        other.m_poCoordTransform = nullptr;
        other.m_hasGeoTransform = false;
        other.m_rasterXSize = 0;
        other.m_rasterYSize = 0;
    }
    return *this;
}

bool GdalParser::isLoaded() const {
    return (m_dataset != nullptr);
}

double GdalParser::getElevationMeters(double lat, double lon) const {
    if (!isLoaded() || !m_band || !m_hasGeoTransform) {
        return 0.0;
    }

    // Traditional GIS order: X = longitude, Y = latitude
    double x_proj = lon;
    while (x_proj > 180.0) x_proj -= 360.0;
    while (x_proj < -180.0) x_proj += 360.0;
    double y_proj = lat;

    if (m_poCoordTransform) {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_poCoordTransform->Transform(1, &x_proj, &y_proj)) {
            return 0.0;
        }
    }

    // Convert projected coordinates to raster pixel space using inverse GeoTransform
    double px = m_invGeoTransform[0] + x_proj * m_invGeoTransform[1] + y_proj * m_invGeoTransform[2];
    double py = m_invGeoTransform[3] + x_proj * m_invGeoTransform[4] + y_proj * m_invGeoTransform[5];

    // Check bounds in raster pixel coordinates
    if (px < 0.0 || px >= m_rasterXSize || py < 0.0 || py >= m_rasterYSize) {
        return 0.0;
    }

    // Determine 2x2 neighborhood bounding pixels
    int x0 = static_cast<int>(std::floor(px));
    int y0 = static_cast<int>(std::floor(py));
    int x1 = x0 + 1;
    int y1 = y0 + 1;

    // Bounds safety for 2x2 window
    if (x0 < 0 || y0 < 0 || x1 >= m_rasterXSize || y1 >= m_rasterYSize) {
        return 0.0;
    }

    double fx = px - x0;
    double fy = py - y0;

    float vals[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        CPLErr err = m_band->RasterIO(GF_Read, x0, y0, 2, 2, vals, 2, 2, GDT_Float32, 0, 0);
        if (err != CE_None) {
            return 0.0;
        }
    }

    float v00 = vals[0]; // (x0, y0)
    float v10 = vals[1]; // (x1, y0)
    float v01 = vals[2]; // (x0, y1)
    float v11 = vals[3]; // (x1, y1)

    // Check NoData values
    auto is_nodata = [this](float val) {
        if (std::isnan(val)) return true;
        if (m_hasNoData && std::abs(val - static_cast<float>(m_noDataValue)) < 1e-4f) {
            return true;
        }
        return false;
    };

    if (is_nodata(v00) || is_nodata(v10) || is_nodata(v01) || is_nodata(v11)) {
        return 0.0;
    }

    // Bilinear interpolation across 2x2 pixel grid
    double top = (1.0 - fx) * v00 + fx * v10;
    double bottom = (1.0 - fx) * v01 + fx * v11;
    double elevation = (1.0 - fy) * top + fy * bottom;

    return elevation;
}

HorizonResult GdalParser::computeHorizonAngleDeg(double lat, double lon, double azimuth_deg,
                                                 double max_dist_km, double step_m) const {
    if (!isLoaded()) {
        return {0.0, 0.0};
    }

    if (max_dist_km <= 0.0 || step_m <= 0.0) {
        return {0.0, 0.0};
    }

    constexpr double R_MOON = LUNAR_RADIUS_METERS; // 1737400.0 m
    constexpr double DEG_TO_RAD = M_PI / 180.0;
    constexpr double RAD_TO_DEG = 180.0 / M_PI;

    // Observer baseline elevation at (lat, lon)
    double h0 = getElevationMeters(lat, lon);

    double phi0 = lat * DEG_TO_RAD;
    double lam0 = lon * DEG_TO_RAD;
    double az_rad = azimuth_deg * DEG_TO_RAD;

    double sin_phi0 = std::sin(phi0);
    double cos_phi0 = std::cos(phi0);
    double sin_az = std::sin(az_rad);
    double cos_az = std::cos(az_rad);

    double max_angle_deg = -90.0;
    double peak_dist_km = 0.0;
    bool found_step = false;

    double max_dist_m = max_dist_km * 1000.0;

    // Step outward along azimuth using spherical trigonometry great-circle stepping
    for (double d = step_m; d <= max_dist_m + 1e-3; d += step_m) {
        double delta = d / R_MOON; // Angular distance along sphere
        double sin_delta = std::sin(delta);
        double cos_delta = std::cos(delta);

        // Spherical destination latitude
        double sin_phi = sin_phi0 * cos_delta + cos_phi0 * sin_delta * cos_az;
        if (sin_phi > 1.0) sin_phi = 1.0;
        if (sin_phi < -1.0) sin_phi = -1.0;
        double phi = std::asin(sin_phi);

        // Spherical destination longitude difference
        double y = sin_az * sin_delta * cos_phi0;
        double x = cos_delta - sin_phi0 * sin_phi;
        double d_lam = std::atan2(y, x);
        double lam = lam0 + d_lam;

        double cur_lat = phi * RAD_TO_DEG;
        double cur_lon = lam * RAD_TO_DEG;

        // Normalize longitude into canonical [-180.0, 180.0] range
        while (cur_lon > 180.0) cur_lon -= 360.0;
        while (cur_lon < -180.0) cur_lon += 360.0;

        double hd = getElevationMeters(cur_lat, cur_lon);

        // Apparent terrain elevation angle accounting for lunar curvature drop:
        // theta(d) = atan2(h(d) - h0 - d^2 / (2 * R_Moon), d) * (180 / pi)
        double curvature_drop = (d * d) / (2.0 * R_MOON);
        double delta_z = hd - h0 - curvature_drop;

        double angle_deg = std::atan2(delta_z, d) * RAD_TO_DEG;

        if (!found_step || angle_deg > max_angle_deg) {
            max_angle_deg = angle_deg;
            peak_dist_km = d / 1000.0;
            found_step = true;
        }
    }

    if (!found_step) {
        return {0.0, 0.0};
    }

    return {max_angle_deg, peak_dist_km};
}

#ifdef BUILD_TEST_GDAL
int main(int argc, char** argv) {
    std::cout << "==========================================================" << std::endl;
    std::cout << "  Lunar Topography & Horizon Ray-Tracing Engine (GDAL)   " << std::endl;
    std::cout << "==========================================================" << std::endl;

    std::string dem_path;
    if (argc > 1) {
        dem_path = argv[1];
    }

    GdalParser parser(dem_path);

    std::cout << "Target DEM Path: " << parser.getDemPath() << std::endl;
    std::cout << "Dataset Status:  " << (parser.isLoaded() ? "Loaded Successfully" : "Not Loaded (Fallback Safe Mode 0.0m)") << std::endl;

    if (parser.isLoaded()) {
        std::cout << "Raster Extents:  " << parser.getRasterWidth() << " x " << parser.getRasterHeight() << " pixels" << std::endl;
        const double* gt = parser.getGeoTransform();
        std::cout << "Origin (X, Y):   (" << gt[0] << ", " << gt[3] << ")" << std::endl;
        std::cout << "Pixel Res (X, Y): (" << gt[1] << ", " << gt[5] << ")" << std::endl;
    }

    struct Location {
        std::string name;
        double lat;
        double lon;
    };

    std::vector<Location> sites = {
        {"Shackleton Rim", -89.9, 0.0},
        {"Haworth Crater", -87.4, 340.5}
    };

    std::vector<double> azimuths = {0.0, 90.0, 180.0, 270.0};

    std::cout << std::fixed << std::setprecision(3);

    for (const auto& site : sites) {
        std::cout << "\n----------------------------------------------------------" << std::endl;
        std::cout << "Target Site: " << site.name << " (lat: " << site.lat << " deg, lon: " << site.lon << " deg)" << std::endl;
        double elev = parser.getElevationMeters(site.lat, site.lon);
        std::cout << "Surface Elevation: " << elev << " m" << std::endl;

        std::cout << "Horizon Profile (50.0 km scan, 100.0 m step):" << std::endl;
        for (double az : azimuths) {
            HorizonResult res = parser.computeHorizonAngleDeg(site.lat, site.lon, az);
            std::cout << "  Azimuth " << std::setw(5) << az << " deg: "
                      << "Max Angle = " << std::setw(7) << res.max_angle_deg << " deg, "
                      << "Peak Distance = " << std::setw(6) << res.peak_distance_km << " km" << std::endl;
        }
    }

    std::cout << "\n==========================================================" << std::endl;
    std::cout << "  Topography Engine Verification Complete               " << std::endl;
    std::cout << "==========================================================" << std::endl;

    return 0;
}
#endif
