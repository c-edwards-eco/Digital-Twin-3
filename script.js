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
// - occupied bookcases are shaded by suffix 2 faculty
// - unknown faculties use the "Other" color


// =============================================================================
// MAP
// =============================================================================

const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: 3
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
// This ensures front books only appear with front shelves,
// and back books only appear with back shelves.

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

// Shelf layers
let shelvesFrontLayer;
let shelvesBackLayer;


// Placeholder book layers
let placeholderBooksFrontLayer;
let placeholderBooksBackLayer;


// Original placeholder GeoJSON.
// Kept unchanged in memory so we can re-filter it after catalogue upload.

let placeholderBooksFrontData = null;
let placeholderBooksBackData = null;


// Faculty configuration
let facultyColors = [];
let facultyColorMap = new Map();


// Catalogue data exists only for the lifetime of this page.
// Refreshing the browser clears all of this.

let catalogueRows = [];


// null means no catalogue has been loaded yet.
// Once loaded, this becomes a Set of bookcase IDs.

let occupiedBookcases = null;


// bookcase ID -> faculty from suffix 2

let bookcaseFacultyMap = new Map();


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

  const bookcaseNumber =
    Math.ceil(shelfNumber / 6);

  return `${bookcaseNumber}${isBack ? 'B' : ''}`;
}


// Converts:
//
// Bookcase 147  -> 147
// Bookcase 99B  -> 99B

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

  facultyColors =
    await response.json();

  facultyColorMap = new Map(
    facultyColors.map(item => [
      String(item.faculty)
        .trim()
        .toUpperCase(),

      String(item.color)
        .trim()
    ])
  );

  console.log(
    `Loaded ${facultyColors.length} faculty colors.`
  );
}

function lightenHexColor(hex, amount = 0.4) {
  const cleanHex = hex.replace('#', '');

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  const newR = Math.round(r + (255 - r) * amount);
  const newG = Math.round(g + (255 - g) * amount);
  const newB = Math.round(b + (255 - b) * amount);

  return `#${[newR, newG, newB]
    .map(value => value.toString(16).padStart(2, '0'))
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
    baseColor =
      facultyColorMap.get('OTHER');
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

function addExpoLabels(shelfLayer) {
  expoLabelsFrontGroup.clearLayers();

  const expoAreas = new Map();

  // Group all reserved shelf polygons by Expo name.
  shelfLayer.eachLayer(layer => {
    const feature = layer.feature;
    const props = feature?.properties || {};

    const reservedName = String(
      props.reserved_name || ''
    ).trim();

    // Only actual Expo areas get permanent labels.
    if (
      !props.reserved ||
      !/\s+Expo$/i.test(reservedName)
    ) {
      return;
    }

    if (!expoAreas.has(reservedName)) {
      expoAreas.set(
        reservedName,
        []
      );
    }

    expoAreas
      .get(reservedName)
      .push(layer);
  });


  // Create ONE label per Expo area,
  // centered across the entire reserved range.
  expoAreas.forEach((layers, expoName) => {
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
          html: `<div>${expoName}</div>`,
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
// SHELF STYLING
// =============================================================================

function shelfStyle(feature) {
  const props =
    feature.properties || {};

  const bookcaseId =
    getBookcaseLabel(feature);

  // Default before catalogue upload,
  // and for empty ordinary bookcases.
  let fillColor = '#ffffff';


  // ---------------------------------------------------------------------------
  // 1. Permanent reserved/exhibition spaces
  // ---------------------------------------------------------------------------

  // This metadata comes from the static physical-wall files
  // and takes precedence over catalogue coloring.

  if (
    props.reserved &&
    props.reserved_faculty
  ) {
    fillColor = getFacultyColor(
      props.reserved_faculty
    );
  }


  // ---------------------------------------------------------------------------
  // 2. Catalogue-driven faculty coloring
  // ---------------------------------------------------------------------------

  else if (
    bookcaseFacultyMap.has(bookcaseId)
  ) {
    const faculty =
      bookcaseFacultyMap.get(bookcaseId);

    fillColor =
      getFacultyColor(faculty);
  }


  return {
    color: '#000',
    weight: 1,
    fillColor,
    fillOpacity: 0.8
  };
}


// =============================================================================
// SHELF TOOLTIPS
// =============================================================================

function addShelfInteraction(
  feature,
  layer
) {
  const props =
    feature.properties || {};

  const bookcaseLabel =
    getBookcaseLabel(feature);

  const reservedName = String(
    props.reserved_name || ''
  ).trim();

  // Expo areas already have a permanent label.
  if (
    props.reserved &&
    /\s+Expo$/i.test(reservedName)
  ) {
    return;
  }

  layer.bindTooltip(
    `Bookcase ${bookcaseLabel}`
  );
}


// =============================================================================
// LOAD SHELVES
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

    const data =
      await response.json();

    shelvesFrontLayer =
      L.geoJSON(data, {

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

      });

    shelvesFrontLayer.addTo(
      shelvesFrontGroup
    );

    addExpoLabels(
      shelvesFrontLayer
    );

    map.fitBounds(
      shelvesFrontLayer.getBounds()
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

    const data =
      await response.json();

    shelvesBackLayer =
      L.geoJSON(data, {

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

      });

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
// PLACEHOLDER BOOK STYLING
// =============================================================================

function placeholderBookStyle(feature) {
  const bookId = Number(
    feature.properties.placeholder_book_id ??
    feature.properties.book_id ??
    0
  );

  // Alternating neutral greys only for
  // visual distinction between fake books.

  const fillColor =
    bookId % 2 === 0
      ? '#4f4f4f'
      : '#8a8a8a';

  return {
    color: '#000',
    weight: 0.5,
    fillColor,
    fillOpacity: 0.45
  };
}


function addPlaceholderBookInteraction(
  feature,
  layer
) {
  const bookcaseLabel =
    getBookcaseLabel(feature);

  layer.bindTooltip(
    `Books on Bookcase ${bookcaseLabel}`
  );
}


// =============================================================================
// PLACEHOLDER BOOK RENDERING
// =============================================================================

function renderPlaceholderBooks(
  data,
  targetGroup,
  label
) {
  // Remove existing version of this
  // placeholder layer.
  targetGroup.clearLayers();


  // Before a catalogue is uploaded,
  // display every physically valid
  // placeholder book.

  let featuresToShow = [];

  // Placeholder books remain hidden until
  // catalogue data has been uploaded.
  if (occupiedBookcases !== null) {
    featuresToShow =
      data.features.filter(feature => {

        const bookcaseId =
          getBookcaseLabel(feature);

        return occupiedBookcases.has(
          bookcaseId
        );
      });
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
    placeholderBooksFrontLayer =
      layer;
  } else {
    placeholderBooksBackLayer =
      layer;
  }
}


async function loadPlaceholderBooks(
  url,
  targetGroup,
  label
) {
  try {
    const response =
      await fetch(url);

    checkResponse(
      response,
      url
    );

    const data =
      await response.json();


    // Keep original geometry
    // untouched in memory.

    if (label === 'front') {
      placeholderBooksFrontData =
        data;
    } else {
      placeholderBooksBackData =
        data;
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
// APPLY CATALOGUE STATE TO MAP
// =============================================================================

function applyCatalogueOccupancy() {
  if (
    occupiedBookcases === null
  ) {
    return;
  }


  if (
    placeholderBooksFrontData
  ) {
    renderPlaceholderBooks(
      placeholderBooksFrontData,
      placeholderBooksFrontGroup,
      'front'
    );
  }


  if (
    placeholderBooksBackData
  ) {
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

  Papa.parse(file, {

    header: true,

    skipEmptyLines: true,

    complete: results => {

      const rows =
        results.data;


      // -----------------------------------------------------------------------
      // Basic file validation
      // -----------------------------------------------------------------------

      if (!rows.length) {
        updateCatalogueStatus(
          'No catalogue records found.',
          true
        );

        return;
      }


      const requiredColumns = [
        'LHR Item Barcode',
        'LHR Item Call Number',
        'Title',
        'suffix 1',
        'suffix 2',
        'suffix 3'
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


      if (
        missingColumns.length > 0
      ) {
        updateCatalogueStatus(
          `Missing columns: ${missingColumns.join(', ')}`,
          true
        );

        return;
      }


      // -----------------------------------------------------------------------
      // Store catalogue in browser memory
      // -----------------------------------------------------------------------

      catalogueRows =
        rows;


      occupiedBookcases =
        new Set();


      bookcaseFacultyMap =
        new Map();


      let locatedBooks = 0;
      let unlocatedBooks = 0;


      // -----------------------------------------------------------------------
      // Parse bookcase + faculty metadata
      // -----------------------------------------------------------------------

      rows.forEach(row => {

        const bookcaseId =
          parseBookcaseFromSuffix(
            row['suffix 3']
          );


        if (!bookcaseId) {
          unlocatedBooks++;
          return;
        }


        occupiedBookcases.add(
          bookcaseId
        );

        locatedBooks++;


        const faculty = String(
          row['suffix 2'] || ''
        ).trim();


        // For now, first faculty encountered
        // for a bookcase determines its color.
        //
        // Later we can add QA checking for
        // bookcases containing conflicting
        // suffix 2 values.

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


      // -----------------------------------------------------------------------
      // Apply catalogue to map
      // -----------------------------------------------------------------------

      applyCatalogueOccupancy();

      applyCatalogueColors();


      console.log(
        'Catalogue rows:',
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


      // -----------------------------------------------------------------------
      // UI status
      // -----------------------------------------------------------------------

      updateCatalogueStatus(
        `${locatedBooks.toLocaleString()} books loaded across ` +
        `${occupiedBookcases.size.toLocaleString()} bookcases` +
        (
          unlocatedBooks > 0
            ? ` · ${unlocatedBooks.toLocaleString()} without a valid bookcase`
            : ''
        )
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
    }

  });
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

      const div =
        L.DomUtil.create(
          'div',
          'info catalogue-upload'
        );


      div.innerHTML = `
        <div class="catalogue-upload-box">

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
            No catalogue loaded
          </div>

        </div>
      `;


      L.DomEvent.disableClickPropagation(
        div
      );

      L.DomEvent.disableScrollPropagation(
        div
      );


      setTimeout(() => {

        const input =
          document.getElementById(
            'catalogue-file-input'
          );


        if (!input) {
          return;
        }


        input.addEventListener(
          'change',
          event => {

            const file =
              event.target.files[0];


            if (!file) {
              return;
            }


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


map.addControl(
  new CatalogueUploadControl()
);


// =============================================================================
// CATALOGUE STATUS UI
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


  status.textContent =
    message;


  status.classList.toggle(
    'catalogue-upload-error',
    isError
  );
}


// =============================================================================
// INITIAL LOAD
// =============================================================================

async function initializeMapData() {
  try {

    // Faculty colors need to exist
    // before shelves are styled.

    await loadFacultyColors();
    addFacultyLegend();


    // Physical shelf geometry

    await Promise.all([
      loadFrontShelves(),
      loadBackShelves()
    ]);


    // Physical placeholder books

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


// =============================================================================
// BASE LAYER
// =============================================================================

frontGroup.addTo(map);


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


// Start application.

initializeMapData();