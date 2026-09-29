// load packages 
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const serverPort = process.env.PORT || 3000;

// api addresses and OpenUV key variables
const cocktailDbApi = 'https://www.thecocktaildb.com/api/json/v1/1';
const openUvApiKey = process.env.OPENUV_API_KEY;
const locationSearchApi = 'https://nominatim.openstreetmap.org/search';
const openUvIndexApi = 'https://api.openuv.io/api/v1/uv';

// track location requests
let lastLocationSearchTime = 0;

// repeated searches don't ask OpenStreetMap for the same place.
const locationCache = {};

// tell express to use ejs template and serve files from public folder
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// read form data, make CSS file available to  browser
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// get cocktail categories to fill the category menu
async function getCategories() {
  const categoryListResponse = await axios.get(cocktailDbApi + '/list.php?c=list');
  return categoryListResponse.data.drinks || [];
}

// find a place with OpenStreetMap, then ask openus for todays uv values
async function getUvForLocation(homeLocation) {
  const normalizedLocationName = homeLocation.toLowerCase();
  let matchingLocation = locationCache[normalizedLocationName];

  
  if (!matchingLocation) {
    const locationSearchResponse = await axios.get(locationSearchApi, {
      params: {
        q: homeLocation,
        format: 'jsonv2',
        limit: 1
      },
      headers: {
        'User-Agent': 'CocktailFinder/1.0 (student project)'
      }
    });
    const matchingLocations = locationSearchResponse.data;

    if (matchingLocations.length === 0) {
      return null;
    }

    matchingLocation = matchingLocations[0];
    locationCache[normalizedLocationName] = matchingLocation;
  }

  // openuv needs latitude and longitude and checks the key in this header
  const uvResponse = await axios.get(openUvIndexApi, {
    params: {
      lat: matchingLocation.lat,
      lng: matchingLocation.lon
    },
    headers: {
      'x-access-token': openUvApiKey
    }
  });
  const uvResult = uvResponse.data.result;
  const maximumUv = Math.round(uvResult.uv_max * 10) / 10;

  return {
    location: matchingLocation.name || matchingLocation.display_name,
    currentUv: Math.round(uvResult.uv * 10) / 10,
    maximumUv: maximumUv,
    sunscreenNeeded: maximumUv >= 3
  };
}

// show random cocktail when the user first opens the site
app.get('/', async function (request, response) {
  let categories = [];
  let cocktail = null;
  let cocktailErrorMessage = '';

  try {
    categories = await getCategories();

    const randomCocktailResponse = await axios.get(cocktailDbApi + '/random.php');
    cocktail = randomCocktailResponse.data.drinks[0];
  } catch {
    cocktailErrorMessage = 'We could not load a cocktail right now. Please try again.';
  }

  // pass value used by ejs template to the page
  response.render('index', {
    categories: categories,
    cocktail: cocktail,
    selectedCategory: '',
    errorMessage: cocktailErrorMessage,
    homeLocation: '',
    uvReport: null,
    uvErrorMessage: ''
  });
});

// handle category form 
// look up uv for location
app.post('/cocktail', async function (request, response) {
  let categories = [];
  let cocktail = null;
  let cocktailErrorMessage = '';
  const selectedCategory = (request.body.category || '').trim();
  const homeLocation = (request.body.location || '').trim();
  let uvReport = null;
  let uvErrorMessage = '';

  // find one cocktail from selected category
  try {
    categories = await getCategories();

    if (selectedCategory) {
      const categoryCocktailsResponse = await axios.get(
        cocktailDbApi + '/filter.php?c=' + encodeURIComponent(selectedCategory)
      );
      const categoryCocktails = categoryCocktailsResponse.data.drinks || [];

      if (categoryCocktails.length > 0) {
        // pick category result
        // get its  recipe details
        const randomCocktailIndex = Math.floor(Math.random() * categoryCocktails.length);
        const selectedCocktail = categoryCocktails[randomCocktailIndex];
        const recipeDetailsResponse = await axios.get(
          cocktailDbApi + '/lookup.php?i=' + encodeURIComponent(selectedCocktail.idDrink)
        );
        cocktail = recipeDetailsResponse.data.drinks[0];
      } else {
        cocktailErrorMessage = 'There are no cocktails in that category. Choose another one.';
      }
    } else {
      const randomCocktailResponse = await axios.get(cocktailDbApi + '/random.php');
      cocktail = randomCocktailResponse.data.drinks[0];
    }
  } catch {
    cocktailErrorMessage = 'We could not find a cocktail. Please choose again and retry.';
  }

  // uv lookup problem shouldn't prevent cocktail result 
  // show uv error message if error
  if (homeLocation) {
    if (!openUvApiKey) {
      uvErrorMessage = 'Add your OpenUV API key to OPENUV_API_KEY in your .env file to check today’s UV index.';
    } else if (Date.now() - lastLocationSearchTime < 1000) {
      uvErrorMessage = 'Please wait one second before checking another location.';
    } else {
      lastLocationSearchTime = Date.now();

      try {
        uvReport = await getUvForLocation(homeLocation);

        if (!uvReport) {
          uvErrorMessage = 'We could not find that location. Check the spelling and try again.';
        }
      } catch (uvRequestError) {
        if (uvRequestError.response && uvRequestError.response.status === 401) {
          uvErrorMessage = 'OpenUV rejected the API key. Check OPENUV_API_KEY in your .env file.';
        } else if (uvRequestError.response && uvRequestError.response.status === 429) {
          uvErrorMessage = 'The OpenUV daily request limit was reached. Please try again tomorrow.';
        } else {
          uvErrorMessage = 'We could not load today’s UV index. Please try again.';
        }
      }
    }
  }

  // render cocktail and uv result or error
  response.render('index', {
    categories: categories,
    cocktail: cocktail,
    selectedCategory: selectedCategory,
    errorMessage: cocktailErrorMessage,
    homeLocation: homeLocation,
    uvReport: uvReport,
    uvErrorMessage: uvErrorMessage
  });
});

// start server on selected port
app.listen(serverPort, function () {
  console.log('Website is running at http://localhost:' + serverPort);
});
