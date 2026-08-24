/* ============================================================
   VidSnatch — Client-side Logic
   ============================================================ */

const API = "https://vidsnatch-1-4suv.onrender.com";

// ── Stored state ─────────────────────────────────────────────
let igVideoUrl = "";
let igCurrentUrl = "";
let igTitle = "";

let ytSelectedFormat = null;
let ytSelectedIsMuxed = false;
let ytAudioFormatId = null;
let ytCurrentUrl = "";
let ytTitle = "";

let activeDownloadJob = null;

// ── Utility helpers ──────────────────────────────────────────

function $(id) {
  return document.getElementById(id);
}

function showToast(msg, duration = 4000) {
  const t = $("toast");

  if (!t) return;

  t.textContent = msg;

  t.classList.add("show");

  clearTimeout(showToast._timer);

  showToast._timer = setTimeout(() => t.classList.remove("show"), duration);
}

function showEl(id) {
  const el = $(id);

  if (el) {
    el.classList.remove("hidden");
  }
}

function hideEl(id) {
  const el = $(id);

  if (el) {
    el.classList.add("hidden");
  }
}

function setElText(id, text) {
  const el = $(id);

  if (el) {
    el.textContent = text;
  }
}

function formatDuration(sec) {
  if (!sec) {
    return "—";
  }

  const h = Math.floor(sec / 3600);

  const m = Math.floor((sec % 3600) / 60);

  const s = Math.floor(sec % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatViews(n) {
  if (!n) {
    return "—";
  }

  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + "M";
  }

  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "K";
  }

  return String(n);
}

// ── Real download job UI ─────────────────────────────────────

function setDownloadProgress(prefix, percent, label) {
  showEl(`${prefix}-progress`);

  const fill = $(`${prefix}-progress-fill`);

  const lbl = $(`${prefix}-progress-label`);

  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));

  if (fill) {
    fill.style.transition = "width 0.35s ease";

    fill.style.width = `${safePercent}%`;
  }

  if (lbl) {
    lbl.textContent =
      safePercent > 0 ? `${label} — ${Math.round(safePercent)}%` : label;
  }
}

function resetDownloadProgress(prefix) {
  const fill = $(`${prefix}-progress-fill`);

  const lbl = $(`${prefix}-progress-label`);

  if (fill) {
    fill.style.transition = "none";

    fill.style.width = "0%";
  }

  if (lbl) {
    lbl.textContent = "⏳ Preparing download...";
  }

  showEl(`${prefix}-progress`);
}

function finishDownloadProgress(prefix) {
  const fill = $(`${prefix}-progress-fill`);

  const lbl = $(`${prefix}-progress-label`);

  if (fill) {
    fill.style.transition = "width 0.35s ease";

    fill.style.width = "100%";
  }

  if (lbl) {
    lbl.textContent = "✅ Download started in your browser";
  }

  setTimeout(() => hideEl(`${prefix}-progress`), 5000);
}

function failDownloadProgress(prefix, message) {
  const lbl = $(`${prefix}-progress-label`);

  if (lbl) {
    lbl.textContent = `❌ ${message || "Download failed"}`;
  }

  setTimeout(() => hideEl(`${prefix}-progress`), 6000);
}

function triggerBrowserDownload(jobId) {
  const a = document.createElement("a");

  a.href = `${API}/api/download/file/${encodeURIComponent(jobId)}`;

  a.style.display = "none";

  a.rel = "noopener";

  document.body.appendChild(a);

  a.click();

  setTimeout(() => a.remove(), 1500);
}

// ── Start download job ──────────────────────────────────────

async function startDownloadJob(params, prefix) {
  if (activeDownloadJob) {
    showToast("⚠️ Another download is already preparing.");

    return;
  }

  activeDownloadJob = true;

  resetDownloadProgress(prefix);

  setDownloadProgress(prefix, 0, "⏳ Preparing download...");

  try {
    const startRes = await fetch(`${API}/api/download/start`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify(params),
    });

    const startData = await startRes.json();

    if (!startRes.ok || !startData.jobId) {
      throw new Error(startData.error || "Could not start download");
    }

    const jobId = startData.jobId;

    let lastProgress = 0;

    setDownloadProgress(prefix, 1, "⏳ Preparing download...");

    showToast("⬇️ Download started — preparing your file...", 4000);

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 700));

      const statusRes = await fetch(
        `${API}/api/download/status/${encodeURIComponent(jobId)}`,
        {
          cache: "no-store",
        },
      );

      const status = await statusRes.json();

      if (!statusRes.ok) {
        throw new Error(status.error || "Could not read download status");
      }

      const progress = Math.max(lastProgress, Number(status.progress) || 0);

      lastProgress = progress;

      let label = status.stage || "Downloading...";

      if (status.status === "downloading") {
        label = `⬇️ ${label}`;
      } else if (status.status === "merging") {
        label = "🔀 Merging video + audio...";
      } else if (status.status === "processing") {
        label = "⚙️ Finalizing file...";
      }

      setDownloadProgress(prefix, progress, label);

      if (status.status === "error") {
        throw new Error(status.error || "Download failed");
      }

      if (status.status === "ready") {
        setDownloadProgress(prefix, 100, "⬇️ Starting browser download...");

        triggerBrowserDownload(jobId);

        finishDownloadProgress(prefix);

        showToast("✅ Download started in your browser!", 5000);

        break;
      }
    }
  } catch (err) {
    console.error("[download]", err);

    failDownloadProgress(prefix, err.message);

    showToast(`❌ ${err.message || "Download failed"}`, 6000);
  } finally {
    activeDownloadJob = false;
  }
}

// ── Instagram ────────────────────────────────────────────────

async function fetchInstagram() {
  const url = $("ig-url-input").value.trim();

  if (!url) {
    showToast("⚠️ Please paste an Instagram Reel URL");

    return;
  }

  igCurrentUrl = url;

  hideEl("ig-result");

  hideEl("ig-error");

  showEl("ig-loader");

  $("ig-fetch-btn").disabled = true;

  try {
    const res = await fetch(`${API}/api/info`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        url,
        type: "instagram",
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to fetch reel info");
    }

    igVideoUrl = data.videoUrl || "";

    igTitle = data.title || "Instagram_Reel";

    const videoEl = $("ig-video");

    if (videoEl) {
      videoEl.src = igVideoUrl;

      videoEl.load();
    }

    setElText("ig-title", data.title || "Instagram Reel");

    setElText("ig-duration", `⏱ ${formatDuration(data.duration)}`);

    setElText("ig-resolution", `📐 ${data.resolution || "HD"}`);

    showEl("ig-result");
  } catch (err) {
    $("ig-error").textContent = `❌ ${err.message}`;

    showEl("ig-error");
  } finally {
    hideEl("ig-loader");

    $("ig-fetch-btn").disabled = false;
  }
}

function downloadInstagramVideo() {
  if (!igCurrentUrl) {
    showToast("⚠️ Fetch the reel first!");

    return;
  }

  startDownloadJob(
    {
      url: igCurrentUrl,

      type: "instagram",

      mediaType: "video",

      videoTitle: igTitle,
    },
    "ig",
  );
}

function downloadInstagramAudio() {
  if (!igCurrentUrl) {
    showToast("⚠️ Fetch the reel first!");

    return;
  }

  startDownloadJob(
    {
      url: igCurrentUrl,

      type: "instagram",

      mediaType: "audio",

      videoTitle: igTitle,
    },
    "ig",
  );
}

// ── YouTube ──────────────────────────────────────────────────

async function fetchYouTube() {
  const url = $("yt-url-input").value.trim();

  if (!url) {
    showToast("⚠️ Please paste a YouTube URL");

    return;
  }

  ytCurrentUrl = url;

  ytSelectedFormat = null;

  ytSelectedIsMuxed = false;

  hideEl("yt-result");

  hideEl("yt-error");

  showEl("yt-loader");

  $("yt-fetch-btn").disabled = true;

  hideEl("yt-dl-wrap");

  try {
    const res = await fetch(`${API}/api/info`, {
      method: "POST",
      
      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        url,
        type: "youtube",
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to fetch video info");
    }

    ytAudioFormatId = data.audioFormatId;

    ytTitle = data.title || "YouTube_Video";

    const thumb = $("yt-thumbnail");

    if (thumb) {
      thumb.src = data.thumbnail || "";

      thumb.alt = data.title || "YouTube Video";
    }

    setElText("yt-title", data.title || "YouTube Video");

    setElText("yt-duration", `⏱ ${formatDuration(data.duration)}`);

    setElText("yt-uploader", `👤 ${data.uploader || "—"}`);

    setElText("yt-views", `👁 ${formatViews(data.viewCount)}`);

    const grid = $("yt-formats");

    grid.innerHTML = "";

    (data.formats || []).forEach((fmt, idx) => {
      const btn = document.createElement("button");

      btn.className = "format-btn";

      btn.dataset.formatId = fmt.formatId;

      btn.textContent = fmt.label || fmt.resolution || `Format ${idx + 1}`;

      btn.onclick = () =>
        selectFormat(btn, fmt.formatId, fmt.isMuxed, fmt.resolution);

      grid.appendChild(btn);
    });

    const firstBtn = grid.querySelector(".format-btn");

    if (firstBtn) {
      firstBtn.click();
    }

    showEl("yt-result");
  } catch (err) {
    $("yt-error").textContent = `❌ ${err.message}`;

    showEl("yt-error");
  } finally {
    hideEl("yt-loader");

    $("yt-fetch-btn").disabled = false;
  }
}

function selectFormat(btn, formatId, isMuxed, resolution) {
  document
    .querySelectorAll(".format-btn")
    .forEach((b) => b.classList.remove("active"));

  btn.classList.add("active");

  ytSelectedFormat = formatId;

  ytSelectedIsMuxed = !!isMuxed;

  const wrap = $("yt-dl-wrap");

  const label = $("yt-dl-label");

  if (wrap) {
    wrap.classList.remove("hidden");

    const dlBtn = $("yt-dl-btn");

    if (dlBtn) {
      dlBtn.style.animation = "none";

      dlBtn.offsetHeight;

      dlBtn.style.animation = "";
    }
  }

  if (label) {
    label.textContent = `⬇️  Download ${resolution || "Video"}`;
  }
}

function downloadYouTubeVideo() {
  if (!ytSelectedFormat) {
    showToast("⚠️ Select a quality first!");

    return;
  }

  if (!ytCurrentUrl) {
    showToast("⚠️ Fetch a video first!");

    return;
  }

  startDownloadJob(
    {
      url: ytCurrentUrl,

      type: "youtube",

      mediaType: "video",

      formatId: ytSelectedFormat,

      isMuxed: ytSelectedIsMuxed,

      videoTitle: ytTitle,
    },
    "yt",
  );
}

function downloadYouTubeAudio() {
  if (!ytCurrentUrl) {
    showToast("⚠️ Fetch a video first!");

    return;
  }

  startDownloadJob(
    {
      url: ytCurrentUrl,

      type: "youtube",

      mediaType: "audio",

      formatId: ytAudioFormatId,

      videoTitle: ytTitle,
    },
    "yt",
  );
}

// ── Enter key shortcuts ──────────────────────────────────────

const igInput = $("ig-url-input");

if (igInput) {
  igInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      fetchInstagram();
    }
  });
}

const ytInput = $("yt-url-input");

if (ytInput) {
  ytInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      fetchYouTube();
    }
  });
}

// ── Expose globals for inline onclick attrs ──────────────────

window.fetchInstagram = fetchInstagram;

window.downloadInstagramVideo = downloadInstagramVideo;

window.downloadInstagramAudio = downloadInstagramAudio;

window.fetchYouTube = fetchYouTube;

window.downloadYouTubeVideo = downloadYouTubeVideo;

window.downloadYouTubeAudio = downloadYouTubeAudio;

window.selectFormat = selectFormat;
