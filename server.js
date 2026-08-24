/**
 * VidSnatch — Express Backend
 * Uses yt-dlp (via yt-dlp-wrap) to fetch info and stream downloads
 * for both Instagram Reels and YouTube videos.
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const util    = require('util');
const { execFile } = require('child_process');

const execFileAsync = util.promisify(execFile);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

// Basic security headers.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Lightweight in-memory rate limit for the expensive yt-dlp endpoints.
const requestLog = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const windowMs = 60_000;
  const maxRequests = 20;
  const recent = (requestLog.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  }
  recent.push(now);
  requestLog.set(key, recent);
  next();
}

// Render the homepage with the real deployment origin so canonical/OG URLs
// never contain a placeholder domain.
app.get('/', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const page = fs.readFileSync(indexPath, 'utf8').replaceAll('{{CANONICAL_URL}}', origin);
  res.type('html').send(page);
});

app.get('/robots.txt', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
  </url>
</urlset>`
  );
});

app.use(express.static(path.join(__dirname, 'public')));


// ── Resolve yt-dlp binary ─────────────────────────────────────
const YtDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');

const BIN_DIR    = path.join(__dirname, 'bin');
const YT_DLP_BIN = process.platform === 'win32'
  ? path.join(BIN_DIR, 'yt-dlp.exe')
  : path.join(BIN_DIR, 'yt-dlp');

// Node.js path — passed to yt-dlp so YouTube JS extraction works
const NODE_BIN = process.execPath;

let ytDlp;

async function ensureYtDlp() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  if (!fs.existsSync(YT_DLP_BIN)) {
    console.log('⬇️  Downloading yt-dlp binary…');
    await YtDlpWrap.downloadFromGithub(YT_DLP_BIN);
    if (process.platform !== 'win32') fs.chmodSync(YT_DLP_BIN, '755');
    console.log('✅ yt-dlp downloaded to', YT_DLP_BIN);
  }
  ytDlp = new YtDlpWrap(YT_DLP_BIN);
}

// ── Base flags injected into every yt-dlp call ───────────────
// --js-runtimes node:<path>  → fixes "No JS runtime" YouTube error
function baseFlags() {
  return [`--js-runtimes`, `node:${NODE_BIN}`];
}

// Only accept URLs from the platforms this app actually supports.
// This also prevents the downloader endpoint from being used as a generic
// server-side URL fetcher.
function isAllowedMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return (
      host === 'instagram.com' ||
      host === 'youtube.com' ||
      host === 'youtu.be' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com'
    );
  } catch {
    return false;
  }
}

// ── Helper: fetch JSON metadata ───────────────────────────────
async function getInfo(url) {
  // Build args manually so we can inject --js-runtimes
  const args = [
    ...baseFlags(),
    '--dump-json',
    '--no-playlist',
    '--',
    url,
  ];

  const { stdout } = await execFileAsync(YT_DLP_BIN, args, {
    maxBuffer: 50 * 1024 * 1024,
  });

  return JSON.parse(stdout.trim().split('\n')[0]); // first JSON line
}

// ── Format label helper ───────────────────────────────────────
function buildFormatLabel(fmt) {
  const res  = fmt.height ? `${fmt.height}p` : (fmt.resolution || '?');
  const fps  = fmt.fps && fmt.fps > 30 ? `${fmt.fps}fps` : '';
  const ext  = fmt.ext ? fmt.ext.toUpperCase() : '';
  const note = fmt.format_note || '';
  const size = fmt.filesize
    ? `~${(fmt.filesize / 1_048_576).toFixed(1)} MB`
    : fmt.filesize_approx
      ? `~${(fmt.filesize_approx / 1_048_576).toFixed(1)} MB`
      : '';
  return [res, fps, note, ext, size].filter(Boolean).join(' · ');
}

// ── POST /api/info ────────────────────────────────────────────
app.post('/api/info', rateLimit, async (req, res) => {
  const { url, type } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (!isAllowedMediaUrl(url)) {
    return res.status(400).json({ error: 'Please use a valid Instagram or YouTube URL.' });
  }
  if (type === 'instagram' && !/instagram\.com/i.test(url)) {
    return res.status(400).json({ error: 'Please use an Instagram URL.' });
  }
  if (type === 'youtube' && !/(youtube\.com|youtu\.be)/i.test(url)) {
    return res.status(400).json({ error: 'Please use a YouTube URL.' });
  }

  try {
    const info = await getInfo(url);

    // ── Instagram ──────────────────────────────────────────────
    if (type === 'instagram') {
      const videoFmt = (info.formats || [])
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      return res.json({
        title:      info.title || info.description || 'Instagram Reel',
        duration:   info.duration,
        resolution: videoFmt ? `${videoFmt.width || '?'}×${videoFmt.height || '?'}` : 'HD',
        thumbnail:  info.thumbnail,
        videoUrl:   videoFmt?.url || info.url || '',
        audioUrl:   videoFmt?.url || info.url || '',
      });
    }

    // ── YouTube ────────────────────────────────────────────────
    const allFmts = info.formats || [];

    // Collect best format per height (prefer muxed, fall back to video-only)
    const byHeight = new Map();

    for (const f of allFmts) {
      if (!f.vcodec || f.vcodec === 'none' || !f.height) continue;
      const key  = `${f.height}`;
      const prev = byHeight.get(key);
      const hasBothStreams = f.acodec && f.acodec !== 'none';

      if (!prev) {
        byHeight.set(key, f);
      } else {
        const prevHasBoth = prev.acodec && prev.acodec !== 'none';
        // Prefer muxed; among equal, prefer larger filesize
        if (!prevHasBoth && hasBothStreams) {
          byHeight.set(key, f);
        } else if (prevHasBoth === hasBothStreams) {
          if ((f.filesize || f.filesize_approx || 0) > (prev.filesize || prev.filesize_approx || 0)) {
            byHeight.set(key, f);
          }
        }
      }
    }

    const sortedVideoFmts = [...byHeight.values()]
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    // Best audio-only format
    const audioFmt = allFmts
      .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    return res.json({
      title:         info.title,
      duration:      info.duration,
      thumbnail:     info.thumbnail,
      uploader:      info.uploader || info.channel,
      viewCount:     info.view_count,
      audioFormatId: audioFmt?.format_id || 'bestaudio',
      formats: sortedVideoFmts.map(f => ({
        formatId:   f.format_id,
        resolution: `${f.height}p`,
        label:      buildFormatLabel(f),
        isMuxed:    !!(f.acodec && f.acodec !== 'none'),
      })),
    });

  } catch (err) {
    console.error('[/api/info] error:', err.message);
    return res.status(500).json({ error: err.message || 'Could not fetch media info' });
  }
});

// ── Sanitize a string for use in a filename ──────────────────
function safeTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/[\\/:*?"<>|]/g, '')   // remove illegal chars
    .replace(/\s+/g, '_')            // spaces → underscores
    .slice(0, 80)                    // max 80 chars
    .trim();
}

// ── POST /api/download ─────────────────────────────────────────
// Accepts both JSON (Content-Type: application/json) and
// form-encoded (Content-Type: application/x-www-form-urlencoded)
app.post('/api/download', rateLimit, async (req, res) => {
  const { url, type, mediaType, formatId, isMuxed, videoTitle } = req.body;
  if (!url) return res.status(400).send('No URL provided');
  if (!isAllowedMediaUrl(url)) return res.status(400).send('Unsupported or invalid media URL.');

  const isAudio  = mediaType === 'audio';
  const ext      = isAudio ? 'mp3' : 'mp4';
  const titlePart = videoTitle ? `_${safeTitle(videoTitle)}` : '';
  const dlName   = `VidSnatch${titlePart}.${ext}`;

  console.log(`[download] "${dlName}" | format=${formatId || 'auto'} | audio=${isAudio}`);

  const stamp   = Date.now();
  const tmpBase = path.join(os.tmpdir(), `vidsnatch_${stamp}`);
  const tmpFile = `${tmpBase}.%(ext)s`;

  try {
    const args = [
      ...baseFlags(),
      '--no-playlist',
      '-o', tmpFile,
      // ── Speed optimisations ──────────────────────────────────
      '--concurrent-fragments', '16',   // download 16 fragments at once
      '--buffer-size', '16K',           // larger read buffer
      '--http-chunk-size', '10M',       // bigger HTTP chunks
      '--no-part',                      // no .part temp files (faster rename)
      '--retries', '10',                // retry on transient errors
    ];

    if (mediaType === 'audio') {
      args.push(
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
      );
    } else if (formatId) {
      const fmtSpec = isMuxed
        ? formatId
        : `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio`;
      args.push(
        '-f', fmtSpec,
        '--merge-output-format', 'mp4',
      );
    } else {
      args.push(
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio',
        '--merge-output-format', 'mp4',
      );
    }

    args.push('--', url);

    console.log('[download] running:', YT_DLP_BIN, args.join(' '));
    await execFileAsync(YT_DLP_BIN, args, { maxBuffer: 1024 * 1024 * 1024, timeout: 5 * 60 * 1000 });

    // Locate the actual output file (yt-dlp fills in ext)
    const tmpDir   = os.tmpdir();
    const prefix   = `vidsnatch_${stamp}`;
    const allFiles = fs.readdirSync(tmpDir);
    const outFile  = allFiles
      .map(f => path.join(tmpDir, f))
      .find(f => path.basename(f).startsWith(prefix));

    if (!outFile || !fs.existsSync(outFile)) {
      throw new Error('Downloaded file not found on server');
    }

    const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';
    console.log(`[download] streaming ${outFile} → ${dlName}`);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
    res.setHeader('Content-Length', fs.statSync(outFile).size);
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('end',  () => { try { fs.unlinkSync(outFile); } catch (_) {} });
    stream.on('error', () => {
      try { fs.unlinkSync(outFile); } catch (_) {}
      if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });

  } catch (err) {
    console.error('[/api/download] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// ── Start ─────────────────────────────────────────────────────
ensureYtDlp()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 VidSnatch running at http://localhost:${PORT}\n`);
      console.log(`   Node.js runtime for yt-dlp: ${NODE_BIN}\n`);
    });
  })
  .catch(err => {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  });
