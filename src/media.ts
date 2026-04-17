/**
 * Media processing — image resize/compress + audio download + STT.
 * Ported from OpenAB's media.rs + stt logic.
 */
import sharp from 'sharp';
import https from 'node:https';
import http from 'node:http';
import { logger } from './logger.js';
import type { SttConfig } from './config.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIM = 1200;
const JPEG_QUALITY = 75;

/** Download URL to Buffer */
export function downloadBuffer(url: string, headers?: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Download, resize (max 1200px), JPEG compress (quality 75), base64 encode.
 * Matches OpenAB's media.rs behavior.
 */
export async function processImage(url: string, authHeaders?: Record<string, string>): Promise<{ mediaType: string; data: string } | null> {
  try {
    const raw = await downloadBuffer(url, authHeaders);
    if (raw.length > MAX_IMAGE_BYTES) {
      logger.warn('Image too large, skipping', { size: raw.length });
      return null;
    }

    const img = sharp(raw);
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    let pipeline = img;
    if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
      pipeline = pipeline.resize(MAX_IMAGE_DIM, MAX_IMAGE_DIM, { fit: 'inside', kernel: 'lanczos3' });
    }

    const buf = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
    return { mediaType: 'image/jpeg', data: buf.toString('base64') };
  } catch (e) {
    logger.warn('Image processing failed', { url, error: (e as Error).message });
    return null;
  }
}

/**
 * Download audio and transcribe via Whisper-compatible API.
 * Supports Groq, OpenAI, or local Whisper server.
 */
export async function transcribeAudio(
  url: string, sttConfig: SttConfig, authHeaders?: Record<string, string>,
): Promise<string | null> {
  if (!sttConfig.enabled || !sttConfig.apiKey) return null;

  try {
    const audio = await downloadBuffer(url, authHeaders);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const filename = 'audio.ogg';

    // Build multipart form data
    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    addField('model', sttConfig.model);
    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
    ));
    parts.push(audio);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const apiUrl = new URL(sttConfig.baseUrl);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: apiUrl.hostname,
        port: apiUrl.port || 443,
        path: apiUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sttConfig.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            resolve(json.text || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', (e) => { logger.warn('STT request failed', { error: e.message }); reject(e); });
      req.write(body);
      req.end();
    });
  } catch (e) {
    logger.warn('Audio transcription failed', { error: (e as Error).message });
    return null;
  }
}
