cmake_minimum_required(VERSION 3.16)
project(lunar_navigator LANGUAGES CXX)

# ---------------------------------------------------------------------------
# Language standard
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ---------------------------------------------------------------------------
# External packages
# ---------------------------------------------------------------------------
find_package(CURL REQUIRED)
find_package(GDAL REQUIRED)

# ---------------------------------------------------------------------------
# Common include directories (Crow, nlohmann/json, GDAL, CURL)
# ---------------------------------------------------------------------------
include_directories(
    /usr/local/include
    /usr/include
    ${CURL_INCLUDE_DIRS}
    ${GDAL_INCLUDE_DIRS}
)

# ---------------------------------------------------------------------------
# Primary executable: lunar_api
# ---------------------------------------------------------------------------
add_executable(lunar_api
    main.cpp
    gdal_parser.cpp
    jpl_ephemeris.cpp
    radio_comms.cpp
)

target_include_directories(lunar_api PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    /usr/local/include
    /usr/include
    ${CURL_INCLUDE_DIRS}
    ${GDAL_INCLUDE_DIRS}
)

target_link_libraries(lunar_api PRIVATE
    gdal
    curl
    pthread
    ${GDAL_LIBRARIES}
    ${CURL_LIBRARIES}
)

# ---------------------------------------------------------------------------
# CLI unit-test executable: test_gdal
# ---------------------------------------------------------------------------
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/test_gdal.cpp")
    add_executable(test_gdal
        test_gdal.cpp
        gdal_parser.cpp
    )
else()
    # Fallback: build gdal_parser.cpp with its embedded test main()
    add_executable(test_gdal
        gdal_parser.cpp
    )
    target_compile_definitions(test_gdal PRIVATE BUILD_TEST_GDAL)
endif()

target_include_directories(test_gdal PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    /usr/local/include
    /usr/include
    ${CURL_INCLUDE_DIRS}
    ${GDAL_INCLUDE_DIRS}
)

target_link_libraries(test_gdal PRIVATE
    gdal
    curl
    pthread
    ${GDAL_LIBRARIES}
    ${CURL_LIBRARIES}
)
