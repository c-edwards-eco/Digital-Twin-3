# Digital Twin 3: Database Supremacy 📚

An interactive digital representation of the TU Delft Library Collection Wall.

The Digital Twin 3 is designed around a simple principle: **the library catalogue is the source of truth for the collection**. The application contains the information required to represent the physical structure of the Collection Wall, while current information about the books themselves is loaded from library catalogue data when needed.

This avoids maintaining the same collection information separately in both the catalogue and the Digital Twin.

The Digital Twin 3 is a refactored version of the Digital Twin 2, which was originally used as a companion application for the rearrangement of the Collection Wall. Instead of being run locally, this version is intended to be used and shared more widely, while being smoothly integrated with the newly enhanced library metadata.

## What the application shows

The application provides an interactive map of the Collection Wall.

By default, without loading any catalogue data, users can:

- Explore the physical structure of the Collection Wall.
- Hover over shelves to identify their bookcase number.
- Switch between the front and back sides of the wall.
- See the locations of permanent faculty exhibition areas.
- See the general placement of faculty-organized books through the faculty color scheme.

The default public view therefore describes the **physical and organizational structure of the Collection Wall**, rather than exposing individual catalogue records.

## Loading current catalogue data

Library staff can additionally reconstruct the current collection using a saved Power BI query.

1. Open the saved Power BI query **Digital Twin Data**.
2. Export the results as a CSV file.
3. Open the Digital Twin 3 in your browser.
4. Select **Load catalogue data** to upload the exported CSV.
5. The application processes the file locally in the browser.

Once the catalogue data has been loaded, the map updates to reflect the current bookcase assignments recorded in the library catalogue.

Bookcases containing books are populated with a representative book layer and shaded according to their faculty metadata. Hovering over the books displays the range of call numbers associated with that bookcase.

Bookcases without books in the uploaded dataset remain empty.

## Catalogue data and privacy

Catalogue data is **not included in the hosted Digital Twin application**.

The Power BI export is processed client-side in the user's browser. The uploaded catalogue data is held temporarily for the current page session and is not permanently stored by the application.

Refreshing or reopening the page returns the application to its default state and the catalogue data must be loaded again.

This architecture allows the public application to provide the permanent physical representation of the Collection Wall without permanently hosting catalogue data.

## Expected Power BI format

The application expects the **Digital Twin Data** export to contain the following columns:

| Column | Purpose |
| --- | --- |
| `LHR Item Barcode` | Item identifier |
| `LHR Item Call Number` | Call number used to determine the range represented by a bookcase |
| `Title` | Bibliographic title |
| `suffix 1` | Floor metadata |
| `suffix 2` | Faculty/collection-area metadata used for coloring |
| `suffix 3` | Bookcase assignment, e.g. `Bookcase 147` or `Bookcase 99B` |

The column names are validated when a CSV is uploaded. A file that does not contain the expected fields will not be processed.

## Faculty coloring

Faculty colors are maintained separately in:

`faculty_colors.json`

When catalogue data is loaded, the value in `suffix 2` is matched against the configured faculty colors.

Recognized faculties receive their corresponding color. Unrecognized values use the configured **Other** color.

Some collection areas are visually differentiated from the main faculty collection while retaining the faculty's base color. For example, a value such as:

`BK Faculty Recommendation`

is recognized as belonging to BK and displayed using a lighter variant of the BK color.

Permanent exhibition areas are also colored according to their associated faculty and labelled directly on the map.

## Wall geometry

The physical wall geometry is generated separately from the catalogue data.

The included R code documents how the shelf geometry was produced from a matrix manually created in Excel.

The matrix describes the physical arrangement of the Collection Wall. The R workflow converts this representation into GeoJSON geometry for use by Leaflet.

Separate geometry is generated for:

- Front shelves
- Back shelves
- Placeholder books
- Reserved/non-book areas

Each physical bookcase contains six shelves. Individual shelves remain represented in the geometry, while collection metadata is primarily maintained and displayed at the **bookcase level**.

For example:

- Shelves 1–6 belong to Bookcase 1.
- Shelves 7–12 belong to Bookcase 2.
- Shelves 1B–6B belong to Bookcase 1B.

This reflects the intended level at which location information is maintained in the library catalogue: books may move between shelves within a bookcase without requiring their catalogue location to be updated.

## Placeholder books

The individual books visible on the map are **representative geometry**, not one polygon per actual catalogue item.

The R workflow generates a set of book-shaped polygons for each usable shelf. These provide a visual representation of occupied collection space without requiring the application to generate thousands of individual geometries from catalogue records.

Placeholder books are hidden when the application first loads.

After a catalogue CSV is uploaded, placeholder books are displayed only for bookcases that contain catalogue records in the uploaded data.

The catalogue records themselves are then used to determine information such as:

- Bookcase occupancy
- Faculty/area coloring
- Call number ranges

This keeps the static map lightweight while allowing the current collection arrangement to be reconstructed dynamically.

## Reserved and exhibition areas

Not every bookcase in the Collection Wall is used for conventional shelving.

Reserved ranges, including faculty exhibition areas, are defined separately from the catalogue collection and are incorporated into the static wall geometry.

These areas:

- Do not receive placeholder books.
- Are shaded using the corresponding faculty color.
- Can have permanent labels such as `BK Expo` or `AE Expo`.
- Are visible without loading catalogue data.

This information represents permanent or semi-permanent characteristics of the physical wall rather than bibliographic metadata and therefore lives outside the library catalogue.

## Technology

The Digital Twin 3 is a static, client-side web application built primarily with:

- **Leaflet** — interactive visualization of the Collection Wall.
- **GeoJSON** — storage of shelf and placeholder-book geometry.
- **JavaScript** — map behavior, dynamic styling, and processing of uploaded catalogue data.
- **Papa Parse** — client-side parsing of Power BI CSV exports.
- **R** — generation and processing of the static wall geometry and configuration data.
- **`sf`** — creation and manipulation of spatial geometry in R.
- **Excel** — source format for the manually defined wall matrix and small configuration datasets (e.g. Expo areas).
- **SAP Power BI** — export of current library catalogue metadata used to reconstruct the collection at runtime.
- **GitHub Pages** — hosting of the static public application.

The hosted application requires **no server-side database or processing**. Catalogue data is loaded and processed locally in the user's browser and is not stored by the application.