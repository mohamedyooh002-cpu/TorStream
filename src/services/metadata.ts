import axios from 'axios';
import { MovieMetadata } from '../types/index.js';
import { getCachedMetadata, setCachedMetadata } from './database.js';
import { parseMovieName, extractQuality, extractYear } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import config from '../config.js';

const OMDB_BASE_URL = 'https://www.omdbapi.com/';

/**
 * Fetch metadata from OMDb API for a given torrent title
 */
export async function fetchMetadata(torrentTitle: string): Promise<MovieMetadata | null> {
  if (!config.omdbApiKey) {
    logger.debug('OMDb API key not set, skipping metadata fetch');
    return null;
  }

  // Extract a probable movie name from the torrent title
  const movieName = parseMovieName(torrentTitle);
  const qualityInfo = extractQuality(torrentTitle);
  const year = extractYear(torrentTitle);

  logger.debug(`Fetching metadata for "${torrentTitle}" → parsed as "${movieName}"`);

  // Check cache first
  const cached = getCachedMetadata(movieName.toLowerCase());
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.Response === 'True' && parsed.Type === 'movie') {
        logger.debug(`Metadata cache hit for "${movieName}"`);
        return buildMetadata(parsed, qualityInfo.quality);
      }
      // Cached but not a movie — return null
      return null;
    } catch {
      // Invalid cache — proceed to fetch
    }
  }

  try {
    const params: Record<string, string> = {
      apikey: config.omdbApiKey,
      t: movieName,
      plot: 'short'
    };

    if (year) {
      params.y = year;
    }

    const response = await axios.get(OMDB_BASE_URL, {
      params,
      timeout: 8000
    });

    const data = response.data;

    // Cache the raw response regardless of result
    setCachedMetadata(movieName.toLowerCase(), JSON.stringify(data));

    if (!data || data.Response !== 'True') {
      logger.debug(`OMDb: no result for "${movieName}"${year ? ` (${year})` : ''}`);
      return null;
    }

    // Only accept movies
    if (data.Type !== 'movie') {
      logger.debug(`OMDb: "${movieName}" is type "${data.Type}", skipping (only movies accepted)`);
      return null;
    }

    return buildMetadata(data, qualityInfo.quality);
  } catch (err) {
    logger.error(`OMDb API error for "${movieName}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build a MovieMetadata object from OMDb response data
 */
function buildMetadata(omdbData: Record<string, string>, quality: string): MovieMetadata {
  return {
    title: omdbData.Title || '',
    year: omdbData.Year || '',
    rated: omdbData.Rated || '',
    released: omdbData.Released || '',
    runtime: omdbData.Runtime || '',
    genre: omdbData.Genre || '',
    director: omdbData.Director || '',
    actors: omdbData.Actors || '',
    plot: omdbData.Plot || '',
    language: omdbData.Language || '',
    country: omdbData.Country || '',
    awards: omdbData.Awards || '',
    poster: omdbData.Poster && omdbData.Poster !== 'N/A' ? omdbData.Poster : '',
    imdbRating: omdbData.imdbRating && omdbData.imdbRating !== 'N/A' ? omdbData.imdbRating : '',
    imdbID: omdbData.imdbID || '',
    type: omdbData.Type || '',
    quality: quality
  };
}

/**
 * Fetch metadata by IMDb ID directly
 */
export async function fetchMetadataByImdbId(imdbId: string): Promise<MovieMetadata | null> {
  if (!config.omdbApiKey) return null;

  try {
    const response = await axios.get(OMDB_BASE_URL, {
      params: {
        apikey: config.omdbApiKey,
        i: imdbId,
        plot: 'short'
      },
      timeout: 8000
    });

    const data = response.data;
    if (!data || data.Response !== 'True' || data.Type !== 'movie') {
      return null;
    }

    return buildMetadata(data, 'Unknown');
  } catch (err) {
    logger.error(`OMDb API error for IMDb ID "${imdbId}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Get a poster placeholder URL
 */
export function getPlaceholderPoster(): string {
  return '/img/placeholder-poster.svg';
}
