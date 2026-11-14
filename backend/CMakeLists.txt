cmake_minimum_required(VERSION 3.16)
project(lunar_navigator LANGUAGES CXX)

# Enforce C++17 Standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Configure required external packages
find_package(CURL REQUIRED)
find_package(GDAL REQUIRED)

# Include directories for Crow (/usr/local/include), nlohmann/json (/usr/include), and dependencies
include_directories(
    /usr/local/include
    /usr/include
    ${CURL_INCLUDE_DIRS}
    ${GDAL_INCLUDE_DIRS}
)

# Executable target definition
add_executable(lunar_api
    main.cpp
)

target_include_directories(lunar_api PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    /usr/local/include
    /usr/include
    ${CURL_INCLUDE_DIRS}
    ${GDAL_INCLUDE_DIRS}
)

# Link against gdal, curl, and pthread
target_link_libraries(lunar_api PRIVATE
    gdal
    curl
    pthread
    ${GDAL_LIBRARIES}
    ${CURL_LIBRARIES}
)
