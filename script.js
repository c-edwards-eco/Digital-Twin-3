// Digital Twin 3: Database Supremacy
//
// Static:
// - front + back shelf geometry
// - front + back placeholder book geometry
// - reserved/exhibition spaces
// - faculty color configuration
//
// Runtime catalogue:
// - CSV remains client-side only
// - occupied bookcases retain placeholder books
// - empty bookcases have placeholder books removed
// - placeholder books are colored by suffix 2 faculty
// - unknown faculties use the "Other" color


// =============================================================================
// MAP
// =============================================================================

const map = L.map('map', {
  crs: L.CRS.Simple,

  zoomSnap: 0.05,

  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  touchZoom: false,
  zoomControl: false
});


// =============================================================================
// LAYER GROUPS
// =============================================================================

const shelvesFrontGroup = L.layerGroup();
const shelvesBackGroup = L.layerGroup();

const placeholderBooksFrontGroup = L.layerGroup();
const placeholderBooksBackGroup = L.layerGroup();

const expoLabelsFrontGroup = L.layerGroup();

// Each side is treated as one complete base layer.
const frontGroup = L.layerGroup([
  shelvesFrontGroup,
  placeholderBooksFrontGroup,
  expoLabelsFrontGroup
]);

const backGroup = L.layerGroup([
  shelvesBackGroup,
  placeholderBooksBackGroup
]);


// =============================================================================
// APPLICATION STATE
// =============================================================================

// Shelf layers.
let shelvesFrontLayer;
let shelvesBackLayer;

// Placeholder book layers.
let placeholderBooksFrontLayer;
let placeholderBooksBackLayer;

// Original placeholder GeoJSON, kept unchanged in memory so it can be
// re-filtered after catalogue upload.
let placeholderBooksFrontData = null;
let placeholderBooksBackData = null;

// Faculty configuration.
let facultyColors = [];
let facultyColorMap = new Map();

// Catalogue data exists only for the lifetime of this page.
let catalogueRows = [];

// null means no catalogue has been loaded yet.
let occupiedBookcases = null;

// Catalogue-derived lookups.
let bookcaseFacultyMap = new Map();
let bookcaseCallNumberRangeMap = new Map();
let callNumberIndex = [];


// =============================================================================
// GENERAL HELPERS
// =============================================================================

function checkResponse(response, url) {
  if (!response.ok) {
    throw new Error(
      `Failed to load ${url}: ${response.status} ${response.statusText}`
    );
  }

  return response;
}

function reportLoadError(label, error) {
  console.error(`${label} failed to load:`, error);
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================================
// CALL NUMBER HELPERS
// =============================================================================

function parsePowerBICallNumber(value) {
  const raw = String(value || '')
    // Power BI / Excel exports may contain non-breaking spaces
    .replace(/\u00A0/g, ' ')
    .trim();

  // If there is no Floor marker, this item cannot
  // be placed on the Collection Wall.
  if (!/\bFloor\b/i.test(raw)) {
    return null;
  }

  // Normalize runs of whitespace for parsing.
  const normalized = raw.replace(/\s+/g, ' ');

  /*
    Expected format:

    ZWA158 Floor 1 Arts and Humanities Bookcase 159
    WBD210 Floor 2 IDE Bookcase 99B

    Groups:
      1 = call number
      2 = floor number
      3 = faculty / area
      4 = bookcase number
  */

  const match = normalized.match(
    /^(.*?)\s+Floor\s+(\d+)\s+(.+?)\s+Bookcase\s+(\d+B?)\s*$/i
  );

  if (!match) {
    return null;
  }

  const callNumber = match[1].trim();
  const floorNumber = match[2].trim();
  const faculty = match[3].trim();
  const bookcaseNumber = match[4].toUpperCase();

  return {
    callNumber,
    suffix1: `Floor ${floorNumber}`,
    suffix2: faculty,
    suffix3: `Bookcase ${bookcaseNumber}`,
    bookcaseId: bookcaseNumber
  };
}

function normalizeCallNumber(callnum) {
  return String(callnum || '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const callNumberCollator = new Intl.Collator(
  undefined,
  {
    numeric: true,
    sensitivity: 'base'
  }
);

function compareCallNumbers(a, b) {
  return callNumberCollator.compare(
    normalizeCallNumber(a),
    normalizeCallNumber(b)
  );
}

function findBestCallNumberMatch(query) {
  const normalizedQuery = normalizeCallNumber(query);

  if (
    !normalizedQuery ||
    callNumberIndex.length === 0
  ) {
    return null;
  }

  // Exact match first.
  const exact = callNumberIndex.find(
    item => item.normalizedCallnum === normalizedQuery
  );

  if (exact) {
    return exact;
  }

  // Otherwise find the natural-sort insertion point.
  const sorted = [...callNumberIndex].sort((a, b) =>
    compareCallNumbers(
      a.normalizedCallnum,
      b.normalizedCallnum
    )
  );

  const insertionIndex = sorted.findIndex(
    item =>
      compareCallNumbers(
        item.normalizedCallnum,
        normalizedQuery
      ) >= 0
  );

  if (insertionIndex === -1) {
    return sorted[sorted.length - 1];
  }

  if (insertionIndex === 0) {
    return sorted[0];
  }

  const prev = sorted[insertionIndex - 1];
  const next = sorted[insertionIndex];

  // Prefer whichever side sorts closest.
  // If ambiguous, prefer the following item.
  const prevCompare = Math.abs(
    compareCallNumbers(
      prev.normalizedCallnum,
      normalizedQuery
    )
  );

  const nextCompare = Math.abs(
    compareCallNumbers(
      next.normalizedCallnum,
      normalizedQuery
    )
  );

  return nextCompare <= prevCompare
    ? next
    : prev;
}


// =============================================================================
// BOOKCASE HELPERS
// =============================================================================

function getBookcaseLabel(feature) {
  const properties = feature?.properties || {};

  // V3 GeoJSON should contain bookcase_id directly.
  if (
    properties.bookcase_id != null &&
    properties.bookcase_id !== ''
  ) {
    return String(properties.bookcase_id).trim();
  }

  // Transitional fallback for older shelf geometry.
  const shelfId = String(
    properties.shelf_id || ''
  ).trim();

  const isBack = /B$/i.test(shelfId);

  const shelfNumber = Number(
    shelfId.replace(/B$/i, '')
  );

  if (!Number.isFinite(shelfNumber)) {
    return 'Unknown';
  }

  const bookcaseNumber = Math.ceil(
    shelfNumber / 6
  );

  return `${bookcaseNumber}${isBack ? 'B' : ''}`;
}

// Converts:
// Bookcase 147 -> 147
// Bookcase 99B -> 99B
function parseBookcaseFromSuffix(value) {
  const text = String(
    value || ''
  ).trim();

  const match = text.match(
    /^Bookcase\s+(\d+)(B?)$/i
  );

  if (!match) {
    return null;
  }

  return `${match[1]}${match[2].toUpperCase()}`;
}

function getShelfGroupForBookcase(
  bookcaseId,
  side
) {
  const shelfLayer =
    side === 'back'
      ? shelvesBackLayer
      : shelvesFrontLayer;

  if (!shelfLayer) {
    return [];
  }

  const matches = [];

  shelfLayer.eachLayer(layer => {
    const feature = layer.feature;

    if (
      feature &&
      getBookcaseLabel(feature) === String(bookcaseId)
    ) {
      matches.push(layer);
    }
  });

  return matches;
}

function setBookcaseHoverStyle(
  bookcaseId,
  side,
  isHovered
) {
  const layers = getShelfGroupForBookcase(
    bookcaseId,
    side
  );

  layers.forEach(layer => {
    if (isHovered) {
      layer.setStyle({
        weight: 3,
        color: '#ffffff'
      });

      if (layer._path) {
        layer._path.classList.add(
          'bookcase-hover'
        );
      }
    } else {
      layer.setStyle(
        shelfStyle(layer.feature)
      );

      if (layer._path) {
        layer._path.classList.remove(
          'bookcase-hover'
        );
      }
    }
  });
}

function getBookcaseTooltipText(bookcaseId) {
  const range = bookcaseCallNumberRangeMap.get(
    String(bookcaseId)
  );

  if (!range) {
    return `Bookcase ${bookcaseId}`;
  }

  const rangeText =
    range.start === range.end
      ? range.start
      : `${range.start} – ${range.end}`;

  return (
    `Bookcase ${bookcaseId}<br>` +
    `Call numbers: ${rangeText}`
  );
}

function getBookcaseFaculty(bookcaseId) {
  return (
    bookcaseFacultyMap.get(
      String(bookcaseId)
    ) || 'Other'
  );
}

function getBookcaseRangeText(bookcaseId) {
  const range = bookcaseCallNumberRangeMap.get(
    String(bookcaseId)
  );

  if (!range) {
    return 'No call number range available';
  }

  if (range.start === range.end) {
    return range.start;
  }

  return `${range.start} – ${range.end}`;
}


// =============================================================================
// FACULTY COLORS
// =============================================================================

async function loadFacultyColors() {
  const response = await fetch(
    'data/faculty_colors.json'
  );

  checkResponse(
    response,
    'data/faculty_colors.json'
  );

  facultyColors = await response.json();

  facultyColorMap = new Map(
    facultyColors.map(item => [
      String(item.faculty)
        .trim()
        .toUpperCase(),

      String(item.color)
        .trim()
    ])
  );

}

function lightenHexColor(hex, amount = 0.4) {
  const cleanHex = hex.replace('#', '');

  const r = parseInt(
    cleanHex.substring(0, 2),
    16
  );

  const g = parseInt(
    cleanHex.substring(2, 4),
    16
  );

  const b = parseInt(
    cleanHex.substring(4, 6),
    16
  );

  const newR = Math.round(
    r + (255 - r) * amount
  );

  const newG = Math.round(
    g + (255 - g) * amount
  );

  const newB = Math.round(
    b + (255 - b) * amount
  );

  return `#${[newR, newG, newB]
    .map(value =>
      value
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function getFacultyColor(faculty) {
  const rawFaculty = String(
    faculty || ''
  ).trim();

  const isRecommendation =
    /\s+Faculty Recommendation$/i.test(rawFaculty);

  const normalizedFaculty = rawFaculty
    .replace(/\s+Faculty Recommendation$/i, '')
    .trim()
    .toUpperCase();

  let baseColor;

  if (
    normalizedFaculty &&
    facultyColorMap.has(normalizedFaculty)
  ) {
    baseColor = facultyColorMap.get(
      normalizedFaculty
    );
  } else if (
    facultyColorMap.has('OTHER')
  ) {
    baseColor = facultyColorMap.get(
      'OTHER'
    );
  } else {
    baseColor = '#ffffff';
  }

  if (isRecommendation) {
    return lightenHexColor(
      baseColor,
      0.22
    );
  }

  return baseColor;
}


// =============================================================================
// STATIC MAP UI
// =============================================================================

function addReservedAreaLabels(shelfLayer) {
  expoLabelsFrontGroup.clearLayers();

  const reservedAreas = new Map();

  // Group all reserved shelf polygons by reserved name.
  shelfLayer.eachLayer(layer => {
    const feature = layer.feature;
    const props = feature?.properties || {};

    const reservedName = String(
      props.reserved_name || ''
    ).trim();

    if (
      !props.reserved ||
      !reservedName
    ) {
      return;
    }

    if (!reservedAreas.has(reservedName)) {
      reservedAreas.set(
        reservedName,
        []
      );
    }

    reservedAreas
      .get(reservedName)
      .push(layer);
  });

  // Create one label per reserved area,
  // centered across the entire reserved range.
  reservedAreas.forEach((layers, areaName) => {
    let bounds = null;

    layers.forEach(layer => {
      if (!bounds) {
        bounds = L.latLngBounds(
          layer.getBounds()
        );
      } else {
        bounds.extend(
          layer.getBounds()
        );
      }
    });

    if (!bounds) {
      return;
    }

    const center =
      bounds.getCenter();

    const label = L.marker(
      center,
      {
        interactive: false,

        icon: L.divIcon({
          className: 'expo-label',
          html: `<div>${areaName}</div>`,
          iconSize: null
        })
      }
    );

    expoLabelsFrontGroup.addLayer(
      label
    );
  });
}

function addFacultyLegend() {
  const legend = L.control({
    position: 'topright'
  });

  legend.onAdd = function () {
    const div = L.DomUtil.create(
      'div',
      'info legend'
    );

    div.innerHTML += `
      <strong>Faculties</strong><br>
    `;

    const other = facultyColors.find(
      item =>
        String(item.faculty)
          .trim()
          .toUpperCase() === 'OTHER'
    );

    const rest = facultyColors.filter(
      item =>
        String(item.faculty)
          .trim()
          .toUpperCase() !== 'OTHER'
    );

    // Always push Other to the bottom.
    const orderedFacultyColors =
      other
        ? [...rest, other]
        : rest;

    orderedFacultyColors.forEach(item => {
      const faculty = String(
        item.faculty || ''
      ).trim();

      const color = String(
        item.color || '#d9d9d9'
      ).trim();

      div.innerHTML += `
        <div style="
          display:flex;
          align-items:center;
          margin-top:4px;
        ">
          <span style="
            display:inline-block;
            width:16px;
            height:16px;
            background:${color};
            margin-right:8px;
            border:none;
          "></span>

          ${faculty}
        </div>
      `;
    });

    return div;
  };

  legend.addTo(map);
}


// =============================================================================
// SHELF STYLING & INTERACTION
// =============================================================================

function shelfStyle(feature) {
  const props = feature.properties || {};

  // Default: white wireframe with no fill.
  let fillColor = '#ffffff';
  let fillOpacity = 0;

  // Permanent Expo areas get a faculty-colored background.
  if (
    props.reserved &&
    props.reserved_faculty
  ) {
    fillColor = getFacultyColor(
      props.reserved_faculty
    );

    fillOpacity = 0.9;
  }

  return {
    color: '#ffffff',
    weight: 1.2,
    fillColor,
    fillOpacity
  };
}

function addShelfInteraction(
  feature,
  layer
) {
  const props = feature.properties || {};

  const bookcaseId = getBookcaseLabel(
    feature
  );

  const reservedName = String(
    props.reserved_name || ''
  ).trim();

  // Expo areas already have permanent labels.
  if (
    props.reserved &&
    reservedName
  ) {
    return;
  }

  layer.bindTooltip(
    getBookcaseTooltipText(bookcaseId)
  );

  const side = String(
    props.side || 'front'
  )
    .trim()
    .toLowerCase();

  layer.on({
    mouseover: () => {
      setBookcaseHoverStyle(
        bookcaseId,
        side,
        true
      );
    },

    mouseout: () => {
      setBookcaseHoverStyle(
        bookcaseId,
        side,
        false
      );
    },

    click: () => {
      openBookcaseExplorer(
        bookcaseId
      );
    }
  });
}


// =============================================================================
// SHELF LOADING
// =============================================================================

async function loadFrontShelves() {
  try {
    const response = await fetch(
      'data/library_shelves_matrix.geojson'
    );

    checkResponse(
      response,
      'data/library_shelves_matrix.geojson'
    );

    const data = await response.json();

    shelvesFrontLayer = L.geoJSON(
      data,
      {
        style: shelfStyle,

        onEachFeature: (
          feature,
          layer
        ) => {
          addShelfInteraction(
            feature,
            layer
          );
        }
      }
    );

    shelvesFrontLayer.addTo(
      shelvesFrontGroup
    );

    addReservedAreaLabels(
      shelvesFrontLayer
    );

    map.fitBounds(
      shelvesFrontLayer.getBounds(),
      {
        animate: false
      }
    );

    map.setZoom(
      map.getZoom() - 0.25,
      {
        animate: false
      }
    );

    // Fine-tune the default wall position:
    // positive X shifts the wall visually left;
    // positive Y shifts the wall visually up.
    map.panBy(
      [50, 30],
      {
        animate: false
      }
    );

  } catch (error) {
    reportLoadError(
      'Front shelves',
      error
    );
  }
}

async function loadBackShelves() {
  try {
    const response = await fetch(
      'data/library_shelves_mirrored.geojson'
    );

    checkResponse(
      response,
      'data/library_shelves_mirrored.geojson'
    );

    const data = await response.json();

    shelvesBackLayer = L.geoJSON(
      data,
      {
        style: shelfStyle,

        onEachFeature: (
          feature,
          layer
        ) => {
          addShelfInteraction(
            feature,
            layer
          );
        }
      }
    );

    shelvesBackLayer.addTo(
      shelvesBackGroup
    );

  } catch (error) {
    reportLoadError(
      'Back shelves',
      error
    );
  }
}


// =============================================================================
// PLACEHOLDER BOOKS
// =============================================================================

function placeholderBookStyle(feature) {
  const bookcaseId = getBookcaseLabel(
    feature
  );

  const faculty = bookcaseFacultyMap.get(
    bookcaseId
  );

  return {
    stroke: false,
    fillColor: getFacultyColor(faculty),
    fillOpacity: 1
  };
}

function addPlaceholderBookInteraction(
  feature,
  layer
) {
  const props = feature.properties || {};

  const bookcaseId = getBookcaseLabel(
    feature
  );

  const side = String(
    props.side || 'front'
  )
    .trim()
    .toLowerCase();

  const range = bookcaseCallNumberRangeMap.get(
    String(bookcaseId)
  );

  if (range) {
    const rangeText =
      range.start === range.end
        ? range.start
        : `${range.start} – ${range.end}`;

    layer.bindTooltip(
      `Call numbers: ${rangeText}`
    );
  } else {
    layer.bindTooltip(
      `Bookcase ${bookcaseId}`
    );
  }

  layer.on({
    mouseover: () => {
      setBookcaseHoverStyle(
        bookcaseId,
        side,
        true
      );
    },

    mouseout: () => {
      setBookcaseHoverStyle(
        bookcaseId,
        side,
        false
      );
    },

    click: () => {
      openBookcaseExplorer(
        bookcaseId
      );
    }
  });
}

function renderPlaceholderBooks(
  data,
  targetGroup,
  label
) {
  // Remove the existing version.
  targetGroup.clearLayers();

  // Placeholder books remain hidden until
  // catalogue data has been uploaded.
  let featuresToShow = [];

  if (occupiedBookcases !== null) {
    featuresToShow = data.features.filter(
      feature => {
        const bookcaseId = getBookcaseLabel(
          feature
        );

        return occupiedBookcases.has(
          bookcaseId
        );
      }
    );
  }

  const filteredData = {
    ...data,
    features: featuresToShow
  };

  const layer = L.geoJSON(
    filteredData,
    {
      style: placeholderBookStyle,
      onEachFeature:
        addPlaceholderBookInteraction
    }
  );

  layer.addTo(targetGroup);

  if (label === 'front') {
    placeholderBooksFrontLayer = layer;
  } else {
    placeholderBooksBackLayer = layer;
  }
}

async function loadPlaceholderBooks(
  url,
  targetGroup,
  label
) {
  try {
    const response = await fetch(url);

    checkResponse(
      response,
      url
    );

    const data = await response.json();

    // Keep the original geometry untouched in memory.
    if (label === 'front') {
      placeholderBooksFrontData = data;
    } else {
      placeholderBooksBackData = data;
    }

    renderPlaceholderBooks(
      data,
      targetGroup,
      label
    );

  } catch (error) {
    reportLoadError(
      `${label} placeholder books`,
      error
    );
  }
}


// =============================================================================
// CATALOGUE-DERIVED MAP UPDATES
// =============================================================================

function applyCatalogueOccupancy() {
  if (occupiedBookcases === null) {
    return;
  }

  if (placeholderBooksFrontData) {
    renderPlaceholderBooks(
      placeholderBooksFrontData,
      placeholderBooksFrontGroup,
      'front'
    );
  }

  if (placeholderBooksBackData) {
    renderPlaceholderBooks(
      placeholderBooksBackData,
      placeholderBooksBackGroup,
      'back'
    );
  }
}

function applyCatalogueColors() {
  if (shelvesFrontLayer) {
    shelvesFrontLayer.setStyle(
      shelfStyle
    );
  }

  if (shelvesBackLayer) {
    shelvesBackLayer.setStyle(
      shelfStyle
    );
  }
}


// =============================================================================
// CATALOGUE CSV PROCESSING
// =============================================================================

function processCatalogueFile(file) {
  Papa.parse(
    file,
    {
      header: true,
      skipEmptyLines: true,

      // Power BI adds an extra first row before
      // the actual CSV header. Remove it before
      // Papa Parse processes the file.
      beforeFirstChunk: chunk => {
        const lines = chunk.split(/\r?\n/);

        return lines
          .slice(1)
          .join('\n');
      },

      complete: results => {
        const rawRows = results.data;

        // ---------------------------------------------------------------------
        // Validate file
        // ---------------------------------------------------------------------

        if (!rawRows.length) {
          updateCatalogueStatus(
            'No catalogue records found.',
            true
          );

          setCallNumberSearchEnabled(false);
          return;
        }

        // These are now the ONLY columns that
        // actually exist in the Power BI export.
        const requiredColumns = [
          'LHR Item Barcode',
          'Title',
          'LHR Item Call Number'
        ];

        const actualColumns =
          results.meta.fields || [];

        const missingColumns =
          requiredColumns.filter(
            column =>
              !actualColumns.includes(
                column
              )
          );

        if (missingColumns.length > 0) {
          updateCatalogueStatus(
            `Missing columns: ${missingColumns.join(', ')}`,
            true
          );

          setCallNumberSearchEnabled(false);
          return;
        }


        // ---------------------------------------------------------------------
        // Reset catalogue state
        // ---------------------------------------------------------------------

        catalogueRows = [];

        occupiedBookcases =
          new Set();

        bookcaseFacultyMap =
          new Map();

        bookcaseCallNumberRangeMap =
          new Map();

        callNumberIndex = [];

        const callNumbersByBookcase =
          new Map();

        let loadedBooks = 0;
        let unableToLoad = 0;


        // ---------------------------------------------------------------------
        // Parse Power BI catalogue rows
        // ---------------------------------------------------------------------

        rawRows.forEach(row => {
          const parsed =
            parsePowerBICallNumber(
              row['LHR Item Call Number']
            );

          // No usable Collection Wall location.
          if (!parsed) {
            unableToLoad++;
            return;
          }


          // ---------------------------------------------------------------
          // Create a normalized internal catalogue row
          // ---------------------------------------------------------------

          const normalizedRow = {
            ...row,

            // Replace the merged Power BI value
            // with the actual call number.
            'LHR Item Call Number':
              parsed.callNumber,

            // Recreate the conceptual suffix
            // fields used elsewhere in the app.
            'suffix 1':
              parsed.suffix1,

            'suffix 2':
              parsed.suffix2,

            'suffix 3':
              parsed.suffix3
          };


          catalogueRows.push(
            normalizedRow
          );


          const bookcaseId =
            parsed.bookcaseId;

          const callNumber =
            parsed.callNumber;

          const faculty =
            parsed.suffix2;


          // ---------------------------------------------------------------
          // Occupancy
          // ---------------------------------------------------------------

          occupiedBookcases.add(
            bookcaseId
          );

          loadedBooks++;


          // ---------------------------------------------------------------
          // Search index
          // ---------------------------------------------------------------

          if (callNumber) {
            callNumberIndex.push({
              callnum: callNumber,

              normalizedCallnum:
                normalizeCallNumber(
                  callNumber
                ),

              bookcaseId
            });
          }


          // ---------------------------------------------------------------
          // Call numbers per bookcase
          // ---------------------------------------------------------------

          if (callNumber) {
            if (
              !callNumbersByBookcase.has(
                bookcaseId
              )
            ) {
              callNumbersByBookcase.set(
                bookcaseId,
                []
              );
            }

            callNumbersByBookcase
              .get(bookcaseId)
              .push(callNumber);
          }


          // ---------------------------------------------------------------
          // Faculty / area
          // ---------------------------------------------------------------

          // First faculty encountered for a bookcase
          // determines its display color.
          if (
            !bookcaseFacultyMap.has(
              bookcaseId
            )
          ) {
            bookcaseFacultyMap.set(
              bookcaseId,
              faculty
            );
          }
        });


        // ---------------------------------------------------------------------
        // Calculate call-number ranges
        // ---------------------------------------------------------------------

        callNumbersByBookcase.forEach(
          (callNumbers, bookcaseId) => {
            const sorted = [
              ...new Set(callNumbers)
            ].sort(compareCallNumbers);

            if (sorted.length === 0) {
              return;
            }

            bookcaseCallNumberRangeMap.set(
              bookcaseId,
              {
                start: sorted[0],
                end:
                  sorted[
                  sorted.length - 1
                  ]
              }
            );
          }
        );


        // ---------------------------------------------------------------------
        // Apply catalogue state to map
        // ---------------------------------------------------------------------

        applyCatalogueOccupancy();
        applyCatalogueColors();

        setCallNumberSearchEnabled(
          true
        );


        // ---------------------------------------------------------------------
        // Debugging
        // ---------------------------------------------------------------------

        console.log(
          'Catalogue rows loaded:',
          catalogueRows
        );

        console.log(
          'Occupied bookcases:',
          occupiedBookcases
        );

        console.log(
          'Bookcase faculties:',
          bookcaseFacultyMap
        );

        console.log(
          'Unable to load:',
          unableToLoad
        );


        // ---------------------------------------------------------------------
        // Update UI
        // ---------------------------------------------------------------------

        updateCatalogueStatus(
          `${loadedBooks.toLocaleString()} books loaded across ` +
          `${occupiedBookcases.size.toLocaleString()} bookcases ` +
          `(${unableToLoad.toLocaleString()} unable to be loaded)`
        );
      },


      error: error => {
        console.error(
          'Catalogue CSV could not be parsed:',
          error
        );

        updateCatalogueStatus(
          'Could not read catalogue file.',
          true
        );

        setCallNumberSearchEnabled(
          false
        );
      }
    }
  );
}

// =============================================================================
// SEARCH & NAVIGATION
// =============================================================================

function setActiveSideForBookcase(
  bookcaseId
) {
  const isBack = /B$/i.test(
    String(bookcaseId)
  );

  map.removeLayer(frontGroup);
  map.removeLayer(backGroup);

  if (isBack) {
    backGroup.addTo(map);
  } else {
    frontGroup.addTo(map);
  }
}

function findBookcaseLayers(
  shelfLayer,
  bookcaseId
) {
  const matches = [];

  shelfLayer.eachLayer(layer => {
    const feature = layer.feature;

    if (
      getBookcaseLabel(feature) ===
      String(bookcaseId)
    ) {
      matches.push(layer);
    }
  });

  return matches;
}

function temporarilyHighlightBookcase(
  bookcaseId,
  duration = 1800
) {
  const side =
    /B$/i.test(String(bookcaseId))
      ? 'back'
      : 'front';

  setBookcaseHoverStyle(
    bookcaseId,
    side,
    true
  );

  setTimeout(() => {
    setBookcaseHoverStyle(
      bookcaseId,
      side,
      false
    );
  }, duration);
}

function focusBookcase(
  bookcaseId
) {
  const isBack = /B$/i.test(
    String(bookcaseId)
  );

  const shelfLayer =
    isBack
      ? shelvesBackLayer
      : shelvesFrontLayer;

  if (!shelfLayer) {
    return;
  }

  const layers =
    findBookcaseLayers(
      shelfLayer,
      bookcaseId
    );

  if (!layers.length) {
    return;
  }

  // Switch to the correct side.
  setActiveSideForBookcase(
    bookcaseId
  );

  // Temporarily glow the whole bookcase.
  temporarilyHighlightBookcase(
    bookcaseId
  );

  // Open tooltip on the middle shelf.
  const middleLayer =
    layers[
    Math.floor(
      layers.length / 2
    )
    ];

  if (middleLayer) {
    middleLayer.openTooltip();
  }
}

function searchByCallNumber(query) {
  const match = findBestCallNumberMatch(
    query
  );

  if (!match) {
    updateCallNumberSearchStatus(
      'No call number found.'
    );

    return;
  }

  focusBookcase(
    match.bookcaseId
  );

  const exact =
    normalizeCallNumber(query) ===
    match.normalizedCallnum;

  updateCallNumberSearchStatus(
    exact
      ? `Found ${match.callnum} in Bookcase ${match.bookcaseId}`
      : `Closest match: ${match.callnum} in Bookcase ${match.bookcaseId}`
  );
}


// =============================================================================
// BOOKCASE EXPLORER
// =============================================================================

function openBookcaseExplorer(bookcaseId) {
  const id = String(bookcaseId);

  // Only catalogue-occupied bookcases are currently browsable.
  if (
    occupiedBookcases === null ||
    !occupiedBookcases.has(id)
  ) {
    return;
  }

  const overlay = document.getElementById(
    'bookcase-modal-overlay'
  );

  const header = document.getElementById(
    'bookcase-modal-header'
  );

  const title = document.getElementById(
    'bookcase-modal-title'
  );

  const meta = document.getElementById(
    'bookcase-modal-meta'
  );

  const content = document.getElementById(
    'bookcase-modal-content'
  );

  if (
    !overlay ||
    !header ||
    !title ||
    !meta ||
    !content
  ) {
    return;
  }

  const faculty =
    getBookcaseFaculty(id);

  const color =
    getFacultyColor(faculty);


  // ---------------------------------------------------------------------------
  // Bookcase contents
  // ---------------------------------------------------------------------------

  const books =
    getBooksForBookcase(id);

  const shelves =
    distributeBooksAcrossShelves(
      books,
      6
    );


  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------

  header.style.backgroundColor =
    color;

  title.textContent =
    `Bookcase ${id}`;

  meta.innerHTML =
    `${faculty}<br>` +
    `Call numbers: ${getBookcaseRangeText(id)}<br>` +
    `<b>${books.length.toLocaleString()}</b> books loaded`;


  // ---------------------------------------------------------------------------
  // Bookshelf
  // ---------------------------------------------------------------------------

  content.innerHTML = `
    <div
      class="bookcase-browser"
      style="--book-color: ${color};"
    >

      ${shelves.map((shelfBooks, shelfIndex) => `
        <div
          class="browser-shelf"
          data-shelf="${shelfIndex + 1}"
        >

          <div class="browser-books ${shelfIndex % 2 === 0 ? 'align-left' : 'align-right'}">

            ${shelfBooks.map(book => `
              <div
                class="browser-book"
                title="${escapeHtmlAttribute(
                  `${book.callNumber}\n${book.title}`
                )}"
                data-barcode="${escapeHtmlAttribute(
                  book.barcode
                )}"
              ></div>
            `).join('')}

          </div>

          <div class="browser-shelf-board"></div>

        </div>
      `).join('')}

    </div>
  `;


  // ---------------------------------------------------------------------------
  // Show explorer
  // ---------------------------------------------------------------------------

  overlay.hidden = false;
}


function closeBookcaseExplorer() {
  const overlay = document.getElementById(
    'bookcase-modal-overlay'
  );

  if (overlay) {
    overlay.hidden = true;
  }
}

function initializeBookcaseExplorer() {
  const overlay = document.getElementById(
    'bookcase-modal-overlay'
  );

  const closeButton = document.getElementById(
    'bookcase-modal-close'
  );

  // Close button.
  if (closeButton) {
    closeButton.addEventListener(
      'click',
      closeBookcaseExplorer
    );
  }

  // Clicking the grey backdrop closes the explorer.
  if (overlay) {
    overlay.addEventListener(
      'click',
      event => {
        if (event.target === overlay) {
          closeBookcaseExplorer();
        }
      }
    );
  }

  // Escape key closes the explorer.
  document.addEventListener(
    'keydown',
    event => {
      if (
        event.key === 'Escape' &&
        overlay &&
        !overlay.hidden
      ) {
        closeBookcaseExplorer();
      }
    }
  );
}

function getBooksForBookcase(bookcaseId) {
  const id = String(bookcaseId);

  const matchingRows = catalogueRows.filter(row => {
    const rowBookcaseId =
      parseBookcaseFromSuffix(
        row['suffix 3']
      );

    return rowBookcaseId === id;
  });


  // Deduplicate primarily by barcode.
  // If a barcode is missing, retain the record using
  // a temporary row-specific key instead.
  const uniqueBooks = new Map();

  matchingRows.forEach((row, index) => {
    const barcode = String(
      row['LHR Item Barcode'] || ''
    ).trim();

    const key =
      barcode ||
      `missing-barcode-${index}`;

    if (!uniqueBooks.has(key)) {
      uniqueBooks.set(
        key,
        {
          barcode,
          callNumber: String(
            row['LHR Item Call Number'] || ''
          ).trim(),
          title: String(
            row['Title'] || ''
          ).trim()
        }
      );
    }
  });


  // Physical browsing order should follow call number.
  return [...uniqueBooks.values()]
    .sort((a, b) =>
      compareCallNumbers(
        a.callNumber,
        b.callNumber
      )
    );
}

function distributeBooksAcrossShelves(
  books,
  shelfCount = 6
) {
  // If spreading across all six shelves would result
  // in fewer than 5 books per shelf, use only
  // the first two visual shelves instead.
  const activeShelfCount =
    books.length / shelfCount < 5
      ? 2
      : shelfCount;

  const shelves =
    Array.from(
      { length: shelfCount },
      () => []
    );

  const baseSize =
    Math.floor(
      books.length / activeShelfCount
    );

  const remainder =
    books.length % activeShelfCount;

  let currentIndex = 0;

  for (
    let shelfIndex = 0;
    shelfIndex < activeShelfCount;
    shelfIndex++
  ) {
    const shelfSize =
      baseSize +
      (
        shelfIndex < remainder
          ? 1
          : 0
      );

    shelves[shelfIndex] =
      books.slice(
        currentIndex,
        currentIndex + shelfSize
      );

    currentIndex += shelfSize;
  }

  return shelves;
}

// =============================================================================
// CATALOGUE UPLOAD UI
// =============================================================================

const CatalogueUploadControl =
  L.Control.extend({

    options: {
      position: 'bottomright'
    },

    onAdd: function () {
      const div = L.DomUtil.create(
        'div',
        'info catalogue-upload'
      );

      div.innerHTML = `
        <div class="catalogue-upload-box">

          <div class="catalogue-tools-row">

            <!-- Catalogue upload -->
            <div class="catalogue-tool catalogue-load-tool">

              <div class="catalogue-upload-title">
                Load catalogue data
              </div>

              <input
                id="catalogue-file-input"
                type="file"
                accept=".csv,text/csv"
                class="catalogue-file-input"
              >

              <div
                id="catalogue-upload-status"
                class="catalogue-upload-status"
              >
                No catalogue loaded.
              </div>

            </div>

            <!-- Call number search -->
            <div class="catalogue-tool callnum-search-section">

              <div class="callnum-search-title">
                Search by call number
              </div>

              <div class="callnum-search-controls">

                <input
                  id="callnum-search-input"
                  type="text"
                  placeholder="Enter call number"
                  class="callnum-search-input"
                  disabled
                >

                <button
                  id="callnum-search-button"
                  type="button"
                  class="callnum-search-button"
                  disabled
                >
                  Search
                </button>

              </div>

              <div
                id="callnum-search-status"
                class="callnum-search-status"
              ></div>

            </div>

          </div>

        </div>
      `;

      // Prevent interaction with the UI from propagating
      // through to Leaflet.
      L.DomEvent.disableClickPropagation(
        div
      );

      L.DomEvent.disableScrollPropagation(
        div
      );

      // Wait until Leaflet has inserted the control
      // into the document before attaching listeners.
      setTimeout(() => {
        const fileInput =
          document.getElementById(
            'catalogue-file-input'
          );

        const searchInput =
          document.getElementById(
            'callnum-search-input'
          );

        const searchButton =
          document.getElementById(
            'callnum-search-button'
          );

        // ---------------------------------------------------------------------
        // Search button
        // ---------------------------------------------------------------------

        if (
          searchButton &&
          searchInput
        ) {
          searchButton.addEventListener(
            'click',
            () => {
              searchByCallNumber(
                searchInput.value
              );
            }
          );
        }

        // ---------------------------------------------------------------------
        // Enter key in search field
        // ---------------------------------------------------------------------

        if (searchInput) {
          searchInput.addEventListener(
            'keydown',
            event => {
              if (event.key === 'Enter') {
                searchByCallNumber(
                  searchInput.value
                );
              }
            }
          );
        }

        // ---------------------------------------------------------------------
        // Catalogue file selection
        // ---------------------------------------------------------------------

        if (!fileInput) {
          return;
        }

        fileInput.addEventListener(
          'change',
          event => {
            const file =
              event.target.files[0];

            if (!file) {
              return;
            }

            // Disable search while a new file is being parsed.
            setCallNumberSearchEnabled(
              false
            );

            updateCallNumberSearchStatus(
              ''
            );

            updateCatalogueStatus(
              'Reading catalogue…'
            );

            processCatalogueFile(
              file
            );
          }
        );

      }, 0);

      return div;
    }
  });


// =============================================================================
// CATALOGUE UI HELPERS
// =============================================================================

function updateCatalogueStatus(
  message,
  isError = false
) {
  const status =
    document.getElementById(
      'catalogue-upload-status'
    );

  if (!status) {
    return;
  }

  status.textContent = message;

  status.classList.toggle(
    'catalogue-upload-error',
    isError
  );
}

function updateCallNumberSearchStatus(
  message
) {
  const status =
    document.getElementById(
      'callnum-search-status'
    );

  if (!status) {
    return;
  }

  status.textContent = message;
}

function setCallNumberSearchEnabled(
  enabled
) {
  const searchInput =
    document.getElementById(
      'callnum-search-input'
    );

  const searchButton =
    document.getElementById(
      'callnum-search-button'
    );

  if (searchInput) {
    searchInput.disabled =
      !enabled;
  }

  if (searchButton) {
    searchButton.disabled =
      !enabled;
  }
}


// =============================================================================
// INITIALIZATION
// =============================================================================

async function initializeMapData() {
  try {
    // Faculty colors must exist before
    // shelves or Expo areas are styled.
    await loadFacultyColors();

    addFacultyLegend();

    // Load physical shelf geometry.
    await Promise.all([
      loadFrontShelves(),
      loadBackShelves()
    ]);

    // Load placeholder geometry into memory.
    // It remains invisible until catalogue data is uploaded.
    await Promise.all([
      loadPlaceholderBooks(
        'data/placeholder_books_front.geojson',
        placeholderBooksFrontGroup,
        'front'
      ),

      loadPlaceholderBooks(
        'data/placeholder_books_back.geojson',
        placeholderBooksBackGroup,
        'back'
      )
    ]);

  } catch (error) {
    console.error(
      'Failed to initialize map:',
      error
    );
  }
}

function initializeBaseLayers() {
  // Front is the default side.
  frontGroup.addTo(map);

  // Front/back selector.
  L.control.layers(
    {
      'Front': frontGroup,
      'Back': backGroup
    },
    null,
    {
      collapsed: false,
      position: 'bottomleft'
    }
  ).addTo(map);

  // Catalogue upload + call-number search.
  map.addControl(
    new CatalogueUploadControl()
  );
}


// =============================================================================
// START APPLICATION
// =============================================================================

initializeBaseLayers();
initializeBookcaseExplorer();
initializeMapData();
