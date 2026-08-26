setwd("C:/Users/chloeedwards/OneDrive - Delft University of Technology/Documents/Github/Digital-Twin-3/data")

######### intro ################################################################

# this script builds the minimum requirements for the mapping application
# primarily spatial data which is not stored in the catalogue

######### libraries ############################################################

library(readxl)
library(writexl)
library(dplyr)
library(tidyr)
library(stringr)
library(purrr)
library(sf)
library(mapview)
library(geojsonio)
library(jsonlite)

######### shelf + bookcase geometry ############################################

grid <- read_excel("wall_matrix.xlsx")

unit_width  <- 2
unit_height <- 1
shelves_per_case <- 6

######### helpers ###############################################################

make_rect <- function(xmin, ymin, xmax, ymax) {
  st_polygon(list(matrix(
    c(
      xmin, ymin,
      xmax, ymin,
      xmax, ymax,
      xmin, ymax,
      xmin, ymin
    ),
    ncol = 2,
    byrow = TRUE
  )))
}


######### calculate matrix layout ###############################################

n_rows <- nrow(grid)
n_cols <- ncol(grid)

# Empty rows are spacers.
# Occupied rows need enough vertical space for all six shelves.
row_heights <- apply(grid, 1, function(row) {
  if (all(row == 0)) {
    unit_height
  } else {
    shelves_per_case * unit_height
  }
})

row_offsets <- cumsum(c(0, head(row_heights, -1)))


######### create front shelves ##################################################

features <- list()

shelf_id <- 1
bookcase_id <- 1

for (r in rev(seq_len(n_rows))) {
  
  for (c in seq_len(n_cols)) {
    
    xmin <- (c - 1) * unit_width
    xmax <- c * unit_width
    base_y <- row_offsets[r]
    
    if (grid[r, c] == 1) {
      
      # Each occupied matrix cell is one bookcase.
      # Each bookcase contains six individually selectable shelf polygons.
      for (s in shelves_per_case:1) {
        
        ymin <- base_y + (s - 1) * unit_height
        ymax <- base_y + s * unit_height
        
        features[[length(features) + 1]] <- list(
          geometry    = make_rect(xmin, ymin, xmax, ymax),
          shelf_id    = shelf_id,
          bookcase_id = bookcase_id,
          shelf_in_case = shelves_per_case - s + 1,
          side        = "front",
          type        = "shelf"
        )
        
        shelf_id <- shelf_id + 1
      }
      
      # Increment ONCE per occupied matrix cell,
      # not once per shelf.
      bookcase_id <- bookcase_id + 1
    }
  }
}


shelves_front <- st_sf(
  shelf_id = sapply(features, `[[`, "shelf_id"),
  bookcase_id = sapply(features, `[[`, "bookcase_id"),
  shelf_in_case = sapply(features, `[[`, "shelf_in_case"),
  side = sapply(features, `[[`, "side"),
  type = sapply(features, `[[`, "type"),
  geometry = st_sfc(lapply(features, `[[`, "geometry")),
  crs = NA
)

######### create backside / mirrored shelves ###################################

all_coords <- do.call(
  rbind,
  lapply(shelves_front$geometry, st_coordinates)
)

x_min <- min(all_coords[, "X"])
x_max <- max(all_coords[, "X"])


mirror_shelf <- function(poly) {
  
  coords <- st_coordinates(poly)[, 1:2]
  
  x_center <- (x_min + x_max) / 2
  
  coords[, 1] <- 2 * x_center - coords[, 1]
  
  st_polygon(list(coords))
}


mirrored_polygons <- lapply(
  shelves_front$geometry,
  mirror_shelf
)


shelves_back <- st_sf(
  shelf_id = paste0(shelves_front$shelf_id, "B"),
  bookcase_id = paste0(shelves_front$bookcase_id, "B"),
  shelf_in_case = shelves_front$shelf_in_case,
  side = "back",
  type = shelves_front$type,
  geometry = st_sfc(mirrored_polygons),
  crs = NA
)

####### initial QA #############################################################

mapview(shelves_front) # check shelves - should be 1080

mapview( # check bookcases - should be 180
  shelves_back,
  zcol = "bookcase_id",
  layer.name = "Bookcase ID" 
)

######### placeholder book layer ###############################################

# these are NOT catalogue books.
#
# they represent all physical locations where books COULD appear.
# catalogue data loaded by the browser will later determine which
# bookcases are actually shown.

books_per_shelf <-10

# fixed seed means the "random" books look the same every time
# we regenerate the static geometry.
set.seed(1234)

######### reserved / exhibition spaces ##########################################

emptyspace <- read_excel("emptyspace.xlsx") %>%
  transmute(
    Start   = as.integer(Start),
    End     = as.integer(End),
    Name    = as.character(Name),
    faculty = as.character(Faculty)
  )


# Expand ranges:
#
# 4–6 CEG Expo
#
# becomes:
#
# 4 CEG Expo
# 5 CEG Expo
# 6 CEG Expo

reserved_bookcases <- emptyspace %>%
  rowwise() %>%
  mutate(
    bookcase_id = list(seq(Start, End))
  ) %>%
  unnest(bookcase_id) %>%
  ungroup() %>%
  select(
    bookcase_id,
    reserved_name = Name,
    reserved_faculty = faculty
  )


reserved_ids <- reserved_bookcases$bookcase_id


######### attach reservation data to front shelves ##############################

# Remove these columns if this section has already been run.
# This makes the code safe to rerun interactively.

shelves_front <- shelves_front %>%
  select(
    -any_of(c(
      "reserved",
      "reserved_name",
      "reserved_faculty"
    ))
  ) %>%
  left_join(
    reserved_bookcases,
    by = "bookcase_id"
  ) %>%
  mutate(
    reserved = !is.na(reserved_name)
  )


######### attach reservation data to back shelves ###############################

shelves_back <- shelves_back %>%
  select(
    -any_of(c(
      "reserved",
      "reserved_name",
      "reserved_faculty",
      "physical_bookcase_id"
    ))
  ) %>%
  mutate(
    physical_bookcase_id = as.integer(
      sub("B$", "", bookcase_id)
    )
  ) %>%
  left_join(
    reserved_bookcases,
    by = c(
      "physical_bookcase_id" = "bookcase_id"
    )
  ) %>%
  mutate(
    reserved = !is.na(reserved_name)
  )

######### placeholder book geometry helper ######################################

make_placeholder_books <- function(
    shelf_geom,
    n_books = 20,
    width_ratio = 0.9,
    gap_ratio = 0.10,
    jitter_ratio = 0.15,
    bottom_padding_ratio = 0.02
) {
  
  coords <- st_coordinates(shelf_geom)[1:4, 1:2]
  
  xmin <- min(coords[, 1])
  xmax <- max(coords[, 1])
  ymin <- min(coords[, 2])
  ymax <- max(coords[, 2])
  
  shelf_width  <- xmax - xmin
  shelf_height <- ymax - ymin
  
  bottom_padding <- shelf_height * bottom_padding_ratio
  
  total_book_width <- shelf_width * width_ratio
  base_book_width  <- total_book_width / n_books
  gap_width        <- base_book_width * gap_ratio
  
  book_width <- (
    total_book_width -
      gap_width * (n_books - 1)
  ) / n_books
  
  x_offset <- (shelf_width - total_book_width) / 2
  
  books <- vector("list", n_books)
  
  current_x <- xmin + x_offset
  
  for (i in seq_len(n_books)) {
    
    # Small horizontal irregularity
    jitter <- runif(
      1,
      -book_width * jitter_ratio,
      book_width * jitter_ratio
    )
    
    x0 <- current_x + jitter
    x1 <- x0 + book_width
    
    # Keep book inside shelf bounds
    if (x0 < xmin) {
      x1 <- x1 + (xmin - x0)
      x0 <- xmin
    }
    
    if (x1 > xmax) {
      x0 <- x0 - (x1 - xmax)
      x1 <- xmax
    }
    
    # Random book height
    height_factor <- runif(1, 0.50, 0.72)
    
    y0 <- ymin + bottom_padding
    y1 <- y0 + shelf_height * height_factor
    
    books[[i]] <- st_polygon(list(matrix(
      c(
        x0, y0,
        x1, y0,
        x1, y1,
        x0, y1,
        x0, y0
      ),
      ncol = 2,
      byrow = TRUE
    )))
    
    current_x <- current_x + book_width + gap_width
  }
  
  books
}

######### generate placeholder books for shelves ################################

generate_placeholder_layer <- function(shelves, n_books = 20) {
  
  # Reserved/exhibition bookcases do not receive fake books.
  shelves_to_fill <- shelves %>%
    filter(!reserved)
  
  book_features <- vector("list", nrow(shelves_to_fill))
  
  for (i in seq_len(nrow(shelves_to_fill))) {
    
    shelf <- shelves_to_fill[i, ]
    
    book_geoms <- make_placeholder_books(
      shelf$geometry[[1]],
      n_books = n_books
    )
    
    book_features[[i]] <- st_sf(
      placeholder_book_id = seq_len(n_books),
      
      shelf_id = rep(
        as.character(shelf$shelf_id),
        n_books
      ),
      
      bookcase_id = rep(
        as.character(shelf$bookcase_id),
        n_books
      ),
      
      shelf_in_case = rep(
        shelf$shelf_in_case,
        n_books
      ),
      
      side = rep(
        shelf$side,
        n_books
      ),
      
      type = "placeholder_book",
      
      geometry = st_sfc(book_geoms)
    )
  }
  
  do.call(rbind, book_features) %>%
    st_as_sf()
}

placeholder_books_front <- generate_placeholder_layer(
  shelves_front,
  n_books = books_per_shelf
)

placeholder_books_back <- generate_placeholder_layer(
  shelves_back,
  n_books = books_per_shelf
)

######## QA check ##############################################################

mapview(
  placeholder_books_front,
  zcol = "bookcase_id",
  layer.name = "Front placeholder books"
)

mapview(
  placeholder_books_back,
  zcol = "bookcase_id",
  layer.name = "Back placeholder books"
)

######## export ################################################################

geojson_write(
  shelves_front,
  file = "library_shelves_matrix.geojson"
)

geojson_write(
  shelves_back,
  file = "library_shelves_mirrored.geojson"
)

geojson_write(
  placeholder_books_front,
  file = "placeholder_books_front.geojson"
)

geojson_write(
  placeholder_books_back,
  file = "placeholder_books_back.geojson"
)

######### faculty colors #########################################################

faculty_colors <- read_excel("faculty_colors.xlsx") %>%
  transmute(
    faculty = as.character(faculty),
    color   = as.character(color)
  )

write(
  toJSON(
    faculty_colors,
    pretty = TRUE,
    auto_unbox = TRUE
  ),
  "faculty_colors.json"
)
