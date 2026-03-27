# Try to find ipebase.h
find_path(IPE_INCLUDE_DIR
        NAMES ipebase.h
        PATH_SUFFIXES ipe
)

# Try to find the ipe library
find_library(IPE_LIBRARY
        NAMES ipe
)

# Mark as found
include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(Ipe DEFAULT_MSG IPE_LIBRARY IPE_INCLUDE_DIR)

# Expose variables
if (Ipe_FOUND)
    set(IPE_LIBRARIES ${IPE_LIBRARY})
    set(IPE_INCLUDE_DIRS ${IPE_INCLUDE_DIR})
endif()
