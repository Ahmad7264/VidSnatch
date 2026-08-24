/**
 * VidSnatch — Express Backend
 * Uses yt-dlp (via yt-dlp-wrap) to fetch info and download files
 * for both Instagram Reels and YouTube videos.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const util = require("util");
const { execFile } = require("child_process");

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────

app.use(cors());

app.use(express.json({ limit: "32kb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "32kb",
  }),
);

// Basic security headers
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

// ── Rate Limit ───────────────────────────────────────────────

const requestLog = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();

  const key = req.ip || req.socket.remoteAddress || "unknown";

  const windowMs = 60_000;

  const maxRequests = 20;

  const recent = (requestLog.get(key) || []).filter((t) => now - t < windowMs);

  if (recent.length >= maxRequests) {
    return res.status(429).json({
      error: "Too many requests. Please try again in a minute.",
    });
  }

  recent.push(now);

  requestLog.set(key, recent);

  next();
}

// ── Homepage ────────────────────────────────────────────────

app.get("/", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;

  const indexPath = path.join(__dirname, "public", "index.html");

  const page = fs
    .readFileSync(indexPath, "utf8")
    .replaceAll("{{CANONICAL_URL}}", origin);

  res.type("html").send(page);
});

// ── Robots ──────────────────────────────────────────────────

app.get("/robots.txt", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;

  res.type("text/plain").send(
    `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`,
  );
});

// ── Sitemap ────────────────────────────────────────────────

app.get("/sitemap.xml", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
  </url>
</urlset>`,
  );
});

// ── Static files ────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

// ── yt-dlp ─────────────────────────────────────────────────

const YtDlpWrap = require("yt-dlp-wrap").default || require("yt-dlp-wrap");

const BIN_DIR = path.join(__dirname, "bin");

const YT_DLP_BIN =
  process.platform === "win32"
    ? path.join(BIN_DIR, "yt-dlp.exe")
    : path.join(BIN_DIR, "yt-dlp");

// Node.js executable path
const NODE_BIN = process.execPath;

let ytDlp;

async function ensureYtDlp() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, {
      recursive: true,
    });
  }

  if (!fs.existsSync(YT_DLP_BIN)) {
    console.log("⬇️  Downloading yt-dlp binary…");

    await YtDlpWrap.downloadFromGithub(YT_DLP_BIN);

    if (process.platform !== "win32") {
      fs.chmodSync(YT_DLP_BIN, "755");
    }

    console.log("✅ yt-dlp downloaded to", YT_DLP_BIN);
  }

  ytDlp = new YtDlpWrap(YT_DLP_BIN);
}

// ── Base yt-dlp flags ──────────────────────────────────────

function baseFlags() {
  return [
    "--js-runtimes",
    `node:${NODE_BIN}`,

    "--extractor-args",
    "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
  ];
}

// ── Allowed URLs ───────────────────────────────────────────

function isAllowedMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

    return (
      host === "instagram.com" ||
      host === "youtube.com" ||
      host === "youtu.be" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

// ── Get media information ──────────────────────────────────

async function getInfo(url) {
  const args = [...baseFlags(), "--dump-json", "--no-playlist", "--", url];

  const { stdout } = await execFileAsync(YT_DLP_BIN, args, {
    maxBuffer: 50 * 1024 * 1024,
  });

  return JSON.parse(stdout.trim().split("\n")[0]);
}

// ── Format label ───────────────────────────────────────────

function buildFormatLabel(fmt) {
  const res = fmt.height ? `${fmt.height}p` : fmt.resolution || "?";

  const fps = fmt.fps && fmt.fps > 30 ? `${fmt.fps}fps` : "";

  const ext = fmt.ext ? fmt.ext.toUpperCase() : "";

  const note = fmt.format_note || "";

  const size = fmt.filesize
    ? `~${(fmt.filesize / 1_048_576).toFixed(1)} MB`
    : fmt.filesize_approx
      ? `~${(fmt.filesize_approx / 1_048_576).toFixed(1)} MB`
      : "";

  return [res, fps, note, ext, size].filter(Boolean).join(" · ");
}

// ── POST /api/info ──────────────────────────────────────────

app.post("/api/info", rateLimit, async (req, res) => {
  const { url, type } = req.body;

  if (!url) {
    return res.status(400).json({
      error: "No URL provided",
    });
  }

  if (!isAllowedMediaUrl(url)) {
    return res.status(400).json({
      error: "Please use a valid Instagram or YouTube URL.",
    });
  }

  if (type === "instagram" && !/instagram\.com/i.test(url)) {
    return res.status(400).json({
      error: "Please use an Instagram URL.",
    });
  }

  if (type === "youtube" && !/(youtube\.com|youtu\.be)/i.test(url)) {
    return res.status(400).json({
      error: "Please use a YouTube URL.",
    });
  }

  try {
    const info = await getInfo(url);

    // ── Instagram ───────────────────────────────────────

    if (type === "instagram") {
      const videoFmt = (info.formats || [])
        .filter(
          (f) =>
            f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none",
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      return res.json({
        title: info.title || info.description || "Instagram Reel",

        duration: info.duration,

        resolution: videoFmt
          ? `${videoFmt.width || "?"}×${videoFmt.height || "?"}`
          : "HD",

        thumbnail: info.thumbnail,

        videoUrl: videoFmt?.url || info.url || "",

        audioUrl: videoFmt?.url || info.url || "",
      });
    }

    // ── YouTube ─────────────────────────────────────────

    const allFmts = info.formats || [];

    const byHeight = new Map();

    for (const f of allFmts) {
      if (!f.vcodec || f.vcodec === "none" || !f.height) {
        continue;
      }

      const key = `${f.height}`;

      const prev = byHeight.get(key);

      const hasBothStreams = f.acodec && f.acodec !== "none";

      if (!prev) {
        byHeight.set(key, f);
      } else {
        const prevHasBoth = prev.acodec && prev.acodec !== "none";

        if (!prevHasBoth && hasBothStreams) {
          byHeight.set(key, f);
        } else if (prevHasBoth === hasBothStreams) {
          if (
            (f.filesize || f.filesize_approx || 0) >
            (prev.filesize || prev.filesize_approx || 0)
          ) {
            byHeight.set(key, f);
          }
        }
      }
    }

    const sortedVideoFmts = [...byHeight.values()].sort(
      (a, b) => (b.height || 0) - (a.height || 0),
    );

    const audioFmt = allFmts
      .filter(
        (f) =>
          f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"),
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    return res.json({
      title: info.title,

      duration: info.duration,

      thumbnail: info.thumbnail,

      uploader: info.uploader || info.channel,

      viewCount: info.view_count,

      audioFormatId: audioFmt?.format_id || "bestaudio",

      formats: sortedVideoFmts.map((f) => ({
        formatId: f.format_id,

        resolution: `${f.height}p`,

        label: buildFormatLabel(f),

        isMuxed: !!(f.acodec && f.acodec !== "none"),
      })),
    });
  } catch (err) {
    console.error("[/api/info] error:", err.message);

    return res.status(500).json({
      error: err.message || "Could not fetch media info",
    });
  }
});

// ── Safe filename ───────────────────────────────────────────

function safeTitle(raw) {
  if (!raw) {
    return "";
  }

  return raw
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80)
    .trim();
}

// ── Async download jobs ─────────────────────────────────────

const downloadJobs = new Map();

const JOB_TTL = 15 * 60 * 1000;

function createDownloadJob() {
  const id = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const job = {
    id,
    status: "queued",
    stage: "Preparing download",
    progress: 0,
    filePath: null,
    filename: null,
    mimeType: null,
    size: 0,
    error: null,
    process: null,
    updatedAt: Date.now(),
  };

  downloadJobs.set(id, job);

  return job;
}

function updateJob(job, values) {
  Object.assign(job, values, {
    updatedAt: Date.now(),
  });
}

function cleanupJob(id) {
  const job = downloadJobs.get(id);

  if (!job) {
    return;
  }

  if (job.process && !job.process.killed) {
    try {
      job.process.kill("SIGTERM");
    } catch (_) {}
  }

  if (job.filePath) {
    try {
      if (fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
    } catch (_) {}
  }

  downloadJobs.delete(id);
}

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of downloadJobs) {
    if (now - job.updatedAt > JOB_TTL) {
      cleanupJob(id);
    }
  }
}, 60000).unref();

function safeAsciiFilename(name) {
  return String(name || "VidSnatch.mp4")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
}

function runDownloadJob(job, { url, mediaType, formatId, videoTitle }) {
  return new Promise((resolve, reject) => {
    const isAudio = mediaType === "audio";

    const extension = isAudio ? "mp3" : "mp4";

    const titlePart = videoTitle ? `_${safeTitle(videoTitle)}` : "";

    const filename = `VidSnatch${titlePart}.${extension}`;

    const stamp = Date.now();

    const tmpDir = os.tmpdir();

    const tmpBase = path.join(tmpDir, `vidsnatch_${stamp}`);

    const tmpFile = `${tmpBase}.%(ext)s`;

    const args = [
      ...baseFlags(),

      "--no-playlist",

      "--newline",

      "-o",
      tmpFile,

      "--concurrent-fragments",
      "16",

      "--buffer-size",
      "1M",

      "--http-chunk-size",
      "10M",

      "--no-part",

      "--retries",
      "10",

      "--fragment-retries",
      "10",

      "--file-access-retries",
      "10",

      "--retry-sleep",
      "fragment:exp=1:20",
    ];

    if (isAudio) {
      args.push(
        "-f",
        "bestaudio/best",

        "-x",

        "--audio-format",
        "mp3",

        "--audio-quality",
        "0",
      );
    } else if (formatId) {
      args.push(
        "-f",
        `${formatId}+bestaudio/best`,

        "--merge-output-format",
        "mp4",
      );
    } else {
      args.push(
        "-f",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",

        "--merge-output-format",
        "mp4",
      );
    }

    args.push("--", url);

    updateJob(job, {
      status: "downloading",

      stage: isAudio ? "Downloading audio" : "Downloading video + audio",

      progress: 1,
    });

    console.log(`[job ${job.id}] running:`, YT_DLP_BIN, args.join(" "));

    const { spawn } = require("child_process");

    const child = spawn(YT_DLP_BIN, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    job.process = child;

    let output = "";

    let settled = false;

    const consume = (chunk) => {
      const text = chunk.toString();

      output = (output + text).slice(-30000);

      if (/Merging formats|Merging format/i.test(text)) {
        updateJob(job, {
          status: "merging",

          stage: "Merging video + audio",

          progress: Math.max(job.progress, 95),
        });

        return;
      }

      if (/ExtractAudio|Post-process|Deleting original file/i.test(text)) {
        updateJob(job, {
          status: "processing",

          stage: isAudio ? "Converting to MP3" : "Finalizing video",

          progress: Math.max(job.progress, 96),
        });

        return;
      }

      const matches = [
        ...text.matchAll(/(?:\[download\]\s+)?(\d+(?:\.\d+)?)%/g),
      ];

      if (matches.length) {
        const pct = Number(matches[matches.length - 1][1]);

        if (Number.isFinite(pct)) {
          updateJob(job, {
            status: "downloading",

            stage: isAudio ? "Downloading audio" : "Downloading video + audio",

            progress: Math.max(
              job.progress,
              Math.min(94, Math.round((5 + pct * 0.89) * 10) / 10),
            ),
          });
        }
      }
    };

    child.stdout.on("data", consume);

    child.stderr.on("data", consume);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;

      if (code !== 0) {
        return reject(
          new Error(`yt-dlp failed${output ? `: ${output.slice(-1200)}` : ""}`),
        );
      }

      try {
        const prefix = `vidsnatch_${stamp}`;

        const files = fs
          .readdirSync(tmpDir)
          .filter((n) => n.startsWith(prefix))
          .map((n) => path.join(tmpDir, n))
          .filter((f) => {
            try {
              return fs.existsSync(f) && fs.statSync(f).isFile();
            } catch {
              return false;
            }
          });

        if (!files.length) {
          throw new Error("Downloaded file not found on server");
        }

        const outFile = files.sort(
          (a, b) => fs.statSync(b).size - fs.statSync(a).size,
        )[0];

        const size = fs.statSync(outFile).size;

        if (size <= 0) {
          throw new Error("Downloaded file is empty");
        }

        updateJob(job, {
          status: "ready",

          stage: "Download ready",

          progress: 100,

          filePath: outFile,

          filename,

          mimeType: isAudio ? "audio/mpeg" : "video/mp4",

          size,

          process: null,
        });

        console.log(
          `[job ${job.id}] ready: ${outFile} (${(size / 1048576).toFixed(
            2,
          )} MB)`,
        );

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ── Async download API ──────────────────────────────────────

app.post("/api/download/start", rateLimit, (req, res) => {
  const { url, mediaType, formatId, videoTitle } = req.body;

  if (!url) {
    return res.status(400).json({
      error: "No URL provided",
    });
  }

  if (!isAllowedMediaUrl(url)) {
    return res.status(400).json({
      error: "Unsupported or invalid media URL.",
    });
  }

  const job = createDownloadJob();

  runDownloadJob(job, {
    url,
    mediaType,
    formatId,
    videoTitle,
  }).catch((err) =>
    updateJob(job, {
      status: "error",

      stage: "Download failed",

      error: err.message || "Download failed",

      process: null,
    }),
  );

  res.status(202).json({
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
  });
});

app.get("/api/download/status/:jobId", rateLimit, (req, res) => {
  const job = downloadJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: "Download job not found or expired.",
    });
  }

  res.json({
    jobId: job.id,

    status: job.status,

    stage: job.stage,

    progress: Math.round(job.progress),

    filename: job.filename,

    size: job.size,

    error: job.error,

    ready: job.status === "ready",
  });
});

app.get("/api/download/file/:jobId", rateLimit, (req, res) => {
  const job = downloadJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).send("Download job not found or expired.");
  }

  if (job.status !== "ready" || !job.filePath) {
    return res.status(409).send("Download is not ready yet.");
  }

  if (!fs.existsSync(job.filePath)) {
    cleanupJob(job.id);

    return res.status(404).send("Downloaded file is no longer available.");
  }

  const size = fs.statSync(job.filePath).size;

  if (size <= 0) {
    cleanupJob(job.id);

    return res.status(500).send("Downloaded file is empty.");
  }

  res.setHeader("Content-Type", job.mimeType || "application/octet-stream");

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeAsciiFilename(
      job.filename,
    )}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
  );

  res.setHeader("Content-Length", size);

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  res.setHeader("X-Content-Type-Options", "nosniff");

  const stream = fs.createReadStream(job.filePath);

  let done = false;

  const cleanup = () => {
    if (done) {
      return;
    }

    done = true;

    try {
      if (fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
    } catch (_) {}

    downloadJobs.delete(job.id);
  };

  stream.on("error", (err) => {
    cleanup();

    if (!res.destroyed) {
      res.destroy(err);
    }
  });

  stream.on("end", cleanup);

  res.on("close", () => {
    if (!res.writableEnded) {
      stream.destroy();
      cleanup();
    }
  });

  stream.pipe(res);
});

// ── Compatibility endpoint for old frontend code ────────────

app.post("/api/download", rateLimit, async (req, res) => {
  const { url, mediaType, formatId, videoTitle } = req.body;

  if (!url) {
    return res.status(400).json({
      error: "No URL provided",
    });
  }

  if (!isAllowedMediaUrl(url)) {
    return res.status(400).json({
      error: "Unsupported or invalid media URL.",
    });
  }

  const job = createDownloadJob();

  try {
    await runDownloadJob(job, {
      url,
      mediaType,
      formatId,
      videoTitle,
    });
  } catch (err) {
    cleanupJob(job.id);

    return res.status(500).json({
      error: err.message || "Download failed",
    });
  }

  res.setHeader("Content-Type", job.mimeType);

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeAsciiFilename(
      job.filename,
    )}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
  );

  res.setHeader("Content-Length", job.size);

  const stream = fs.createReadStream(job.filePath);

  stream.on("end", () => cleanupJob(job.id));

  stream.on("error", () => cleanupJob(job.id));

  stream.pipe(res);
});

// ── Start Server ────────────────────────────────────────────

ensureYtDlp()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 VidSnatch running at http://localhost:${PORT}\n`);

      console.log(`   Node.js runtime for yt-dlp: ${NODE_BIN}\n`);
    });
  })
  .catch((err) => {
    console.error("❌ Startup error:", err.message);

    process.exit(1);
  });
