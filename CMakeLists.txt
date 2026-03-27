cmake_minimum_required(VERSION 3.30)
project(ipe_svg)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

find_package(Cairo REQUIRED)
find_package(Ipe REQUIRED)
find_package(Freetype REQUIRED)

add_executable(ipe_svg main.cpp
        ipe/src/ipecairo/ipecairopainter.cpp
        ipe/src/ipecairo/ipefonts.cpp
        ipe/src/ipecairo/ipethumbs.cpp)

target_include_directories(ipe_svg PRIVATE ${CAIRO_INCLUDE_DIR} ${IPE_INCLUDE_DIRS} "${CMAKE_CURRENT_SOURCE_DIR}/ipe/src/ipecairo" ${FREETYPE_INCLUDE_DIRS})
target_link_libraries(ipe_svg PRIVATE ${CAIRO_LIBRARIES} ${IPE_LIBRARIES} ${FREETYPE_LIBRARIES})
