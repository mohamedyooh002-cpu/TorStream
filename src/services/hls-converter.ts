import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getHlsDir } from '../utils/helpers.js';
import { updateMovie } from './database.js';
import logger from '../utils/logger.js';
import { Server as SocketServer } from 'socket.io';

const require = createRequire(import.meta.url);

// Use bundled ffmpeg/ffprobe binaries from npm packages
try {
  const ffmpegPath: string = require('ffmpeg-static');
  const ffprobePath: string = require('@ffprobe-installer/ffprobe').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  logger.info(`Using bundled ffmpeg: ${ffmpegPath}`);
  logger.info(`Using bundled ffprobe: ${ffprobePath}`);
} catch (e) {
  logger.warn(`Could not load bundled ffmpeg binaries: ${(e as Error).message}`);
}

let io: SocketServer;

/**
 * Set the Socket.IO instance for progress reporting
 */
export function setHlsSocketIo(socketIo: SocketServer): void {
  io = socketIo;
}

/**
 * Check if ffmpeg and ffprobe are available
 */
export function checkFfmpegAvailability(): { ffmpeg: boolean; ffprobe: boolean } {
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;

  try {
    // Check bundled binary first
    const ffmpegPath: string = require('ffmpeg-static');
    ffmpegAvailable = fs.existsSync(ffmpegPath);
  } catch { /* fall through */ }

  if (!ffmpegAvailable) {
    try {
      const result = require('child_process').execSync('ffmpeg -version', { encoding: 'utf-8', timeout: 5000 });
      ffmpegAvailable = result.includes('ffmpeg version');
    } catch { /* not found */ }
  }

  try {
    const ffprobePath: string = require('@ffprobe-installer/ffprobe').path;
    ffprobeAvailable = fs.existsSync(ffprobePath);
  } catch { /* fall through */ }

  if (!ffprobeAvailable) {
    try {
      const result = require('child_process').execSync('ffprobe -version', { encoding: 'utf-8', timeout: 5000 });
      ffprobeAvailable = result.includes('ffprobe version');
    } catch { /* not found */ }
  }

  return { ffmpeg: ffmpegAvailable, ffprobe: ffprobeAvailable };
}

/**
 * Get video codec information using ffprobe
 */
export function getVideoCodec(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe error: ${err.message}`));
        return;
      }

      const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
      if (videoStream) {
        resolve(videoStream.codec_name || 'unknown');
      } else {
        reject(new Error('No video stream found'));
      }
    });
  });
}

/**
 * Get video duration in seconds using ffprobe
 */
export function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe error: ${err.message}`));
        return;
      }

      const duration = metadata.format?.duration;
      if (duration) {
        resolve(Math.round(duration));
      } else {
        const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
        if (videoStream?.duration) {
          resolve(Math.round(parseFloat(videoStream.duration)));
        } else {
          resolve(0);
        }
      }
    });
  });
}

/**
 * Convert a video file to HLS format
 */
export async function convertToHls(movieId: string, infoHash: string, videoPath: string): Promise<string> {
  const hlsDir = getHlsDir(infoHash);
  const masterPlaylistPath = path.join(hlsDir, 'master.m3u8');

  // Skip if already converted
  if (fs.existsSync(masterPlaylistPath)) {
    logger.info(`HLS already exists for ${infoHash}, skipping conversion`);
    return masterPlaylistPath;
  }

  // Create HLS directory
  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  // Check video codec to decide between copy and re-encode
  let videoCodec = 'unknown';
  try {
    videoCodec = await getVideoCodec(videoPath);
  } catch (err) {
    logger.warn(`Could not determine video codec for ${videoPath}, will attempt copy: ${(err as Error).message}`);
  }

  // Get duration for thumbnail
  let duration = 0;
  try {
    duration = await getVideoDuration(videoPath);
  } catch {
    logger.warn(`Could not determine video duration for ${videoPath}`);
  }

  const canCopyCodec = ['h264', 'hevc', 'h265', 'mpeg4', 'avc'].includes(videoCodec.toLowerCase());

  logger.info(`Converting ${infoHash} to HLS (codec: ${videoCodec}, copy: ${canCopyCodec})`);

  // Update status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateMovie(movieId, { status: 'converting' } as any);

  // Convert
  await new Promise<void>((resolve, reject) => {
    let command = ffmpeg(videoPath);

    if (canCopyCodec) {
      // Fast remux without re-encoding
      command = command
        .videoCodec('copy')
        .audioCodec('aac')
        .audioBitrate('128k')
        .audioChannels(2);
    } else {
      // Re-encode to H.264
      logger.info(`Re-encoding ${infoHash} from ${videoCodec} to H.264`);
      command = command
        .videoCodec('libx264')
        .outputOptions('-preset fast', '-crf 23')
        .audioCodec('aac')
        .audioBitrate('128k')
        .audioChannels(2);
    }

    command
      .format('hls')
      .outputOptions([
        '-hls_time 6',
        '-hls_list_size 0',
        `-hls_segment_filename`, `${path.join(hlsDir, 'segment_%04d.ts')}`
      ])
      .output(masterPlaylistPath)
      .on('start', (cmdLine: string) => {
        logger.debug(`FFmpeg command: ${cmdLine}`);
      })
      .on('progress', (progress: { percent?: number }) => {
        if (progress.percent && io) {
          io.emit('conversion-progress', {
            type: 'conversion-progress',
            data: {
              id: movieId,
              infoHash,
              progress: Math.round(progress.percent),
              status: 'converting'
            }
          });
        }
      })
      .on('end', () => {
        logger.info(`HLS conversion complete for ${infoHash}`);
        resolve();
      })
      .on('error', (err: Error) => {
        logger.error(`HLS conversion error for ${infoHash}: ${err.message}`);
        reject(err);
      })
      .run();
  });

  // Generate poster/thumbnail at 10% mark
  if (duration > 0) {
    try {
      const seekTime = Math.round(duration * 0.1);
      const posterPath = path.join(hlsDir, 'poster.jpg');

      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(seekTime)
          .frames(1)
          .outputOptions('-q:v 2')
          .output(posterPath)
          .on('end', () => {
            logger.info(`Poster generated for ${infoHash}`);
            updateMovie(movieId, { local_poster: posterPath } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
            resolve();
          })
          .on('error', (err: Error) => {
            logger.warn(`Poster generation failed for ${infoHash}: ${err.message}`);
            resolve(); // Non-fatal
          })
          .run();
      });
    } catch (err) {
      logger.warn(`Poster generation error: ${(err as Error).message}`);
    }
  }

  // Update duration in DB
  if (duration > 0) {
    updateMovie(movieId, { duration_seconds: duration } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  return masterPlaylistPath;
}

/**
 * Re-convert a movie to HLS (delete existing HLS and re-run)
 */
export async function reconvertToHls(movieId: string, infoHash: string, videoPath: string): Promise<string> {
  const hlsDir = getHlsDir(infoHash);

  // Delete existing HLS files
  if (fs.existsSync(hlsDir)) {
    const files = fs.readdirSync(hlsDir);
    for (const file of files) {
      if (file.endsWith('.m3u8') || file.endsWith('.ts') || file.endsWith('.jpg')) {
        fs.unlinkSync(path.join(hlsDir, file));
      }
    }
  }

  return convertToHls(movieId, infoHash, videoPath);
}
