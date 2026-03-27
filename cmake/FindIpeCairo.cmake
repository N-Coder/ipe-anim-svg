# Try to find the ipe cairo library
find_library(IPE_CAIRO_LIBRARY
        NAMES ipecairo
)

# Mark as found
include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(IpeCairo DEFAULT_MSG IPE_CAIRO_LIBRARY)

# Expose variables
if (Ipe_CAIRO_FOUND)
    set(IPE_CAIRO_LIBRARIES ${IPE_CAIRO_LIBRARY})
endif()
