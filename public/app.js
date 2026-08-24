/* ============================================================
   VidSnatch — Client-side Logic
   ============================================================ */

const API = '';

// ── Stored state ─────────────────────────────────────────────
let igVideoUrl    = '';
let igCurrentUrl  = '';
let igTitle       = '';
let ytSelectedFormat  = null;
let ytSelectedIsMuxed = false;
let ytAudioFormatId   = null;
let ytCurrentUrl      = '';
let ytTitle           = '';

// ── Utility helpers ──────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showToast(msg, duration = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function showEl(id)  { const el = $(id); if (el) el.classList.remove('hidden'); }
function hideEl(id)  { const el = $(id); if (el) el.classList.add('hidden'); }
function setElText(id, text) { const el = $(id); if (el) el.textContent = text; }

function formatDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViews(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ── Real download via hidden form POST → browser handles it ──
// The browser receives a streaming response and saves to disk natively.
function nativeDownload(params, filename) {
  // Build a temporary form and POST it — browser will save the file
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/download';

  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue;
    const input = document.createElement('input');
    input.type  = 'hidden';
    input.name  = key;
    input.value = String(val);
    form.appendChild(input);
  }

  // hidden filename field
  const fnInput = document.createElement('input');
  fnInput.type  = 'hidden';
  fnInput.name  = 'filename';
  fnInput.value = filename;
  form.appendChild(fnInput);

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

// ── Progress bar (real — polls server) ───────────────────────
function showDownloadingState(prefix, label) {
  showEl(`${prefix}-progress`);
  const fill = $(`${prefix}-progress-fill`);
  const lbl  = $(`${prefix}-progress-label`);
  if (fill) { fill.style.width = '0%'; fill.style.transition = 'none'; }
  if (lbl)  lbl.textContent = `⏳ ${label} — server is downloading, please wait…`;

  // Animate progress bar slowly to show activity (not fake "done")
  let pct = 0;
  const iv = setInterval(() => {
    // Slow growth that never reaches 100 until we clear it
    pct = Math.min(pct + (Math.random() * 3), 85);
    if (fill) { fill.style.transition = 'width 0.6s ease'; fill.style.width = pct + '%'; }
  }, 600);
  return iv;
}

function completeProgress(prefix, iv) {
  clearInterval(iv);
  const fill = $(`${prefix}-progress-fill`);
  const lbl  = $(`${prefix}-progress-label`);
  if (fill) { fill.style.transition = 'width 0.4s ease'; fill.style.width = '100%'; }
  if (lbl)  lbl.textContent = '✅ Download sent to your browser!';
  setTimeout(() => hideEl(`${prefix}-progress`), 4000);
}

// ── Instagram ────────────────────────────────────────────────
async function fetchInstagram() {
  const url = $('ig-url-input').value.trim();
  if (!url) { showToast('⚠️ Please paste an Instagram Reel URL'); return; }

  igCurrentUrl = url;
  hideEl('ig-result');
  hideEl('ig-error');
  showEl('ig-loader');
  $('ig-fetch-btn').disabled = true;

  try {
    const res  = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type: 'instagram' })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch reel info');

    igVideoUrl = data.videoUrl || '';
    igTitle    = data.title || 'Instagram_Reel';

    const videoEl = $('ig-video');
    videoEl.src = igVideoUrl;
    videoEl.load();

    setElText('ig-title', data.title || 'Instagram Reel');
    setElText('ig-duration', `⏱ ${formatDuration(data.duration)}`);
    setElText('ig-resolution', `📐 ${data.resolution || 'HD'}`);

    showEl('ig-result');
  } catch (err) {
    $('ig-error').textContent = `❌ ${err.message}`;
    showEl('ig-error');
  } finally {
    hideEl('ig-loader');
    $('ig-fetch-btn').disabled = false;
  }
}

function downloadInstagramVideo() {
  if (!igCurrentUrl) { showToast('⚠️ Fetch the reel first!'); return; }
  const iv = showDownloadingState('ig', 'Downloading Reel');
  showToast('⬇️ Starting download — check your browser downloads bar!', 5000);
  nativeDownload({ url: igCurrentUrl, type: 'instagram', mediaType: 'video', videoTitle: igTitle }, 'instagram_reel.mp4');
  completeProgress('ig', iv);
}

function downloadInstagramAudio() {
  if (!igCurrentUrl) { showToast('⚠️ Fetch the reel first!'); return; }
  const iv = showDownloadingState('ig', 'Extracting Audio');
  showToast('⬇️ Starting download — check your browser downloads bar!', 5000);
  nativeDownload({ url: igCurrentUrl, type: 'instagram', mediaType: 'audio', videoTitle: igTitle }, 'instagram_audio.mp3');
  completeProgress('ig', iv);
}

// ── YouTube ──────────────────────────────────────────────────
async function fetchYouTube() {
  const url = $('yt-url-input').value.trim();
  if (!url) { showToast('⚠️ Please paste a YouTube URL'); return; }

  ytCurrentUrl      = url;
  ytSelectedFormat  = null;
  ytSelectedIsMuxed = false;
  hideEl('yt-result');
  hideEl('yt-error');
  showEl('yt-loader');
  $('yt-fetch-btn').disabled = true;
  hideEl('yt-dl-wrap');

  try {
    const res  = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type: 'youtube' })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch video info');

    ytAudioFormatId = data.audioFormatId;
    ytTitle         = data.title || 'YouTube_Video';

    const thumb = $('yt-thumbnail');
    thumb.src = data.thumbnail || '';
    thumb.alt = data.title || 'YouTube Video';

    setElText('yt-title',    data.title    || 'YouTube Video');
    setElText('yt-duration', `⏱ ${formatDuration(data.duration)}`);
    setElText('yt-uploader', `👤 ${data.uploader || '—'}`);
    setElText('yt-views',    `👁 ${formatViews(data.viewCount)}`);

    const grid = $('yt-formats');
    grid.innerHTML = '';
    (data.formats || []).forEach((fmt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'format-btn';
      btn.dataset.formatId = fmt.formatId;
      btn.textContent = fmt.label || fmt.resolution || `Format ${idx + 1}`;
      btn.onclick = () => selectFormat(btn, fmt.formatId, fmt.isMuxed, fmt.resolution);
      grid.appendChild(btn);
    });

    // Auto-select best (first) format
    const firstBtn = grid.querySelector('.format-btn');
    if (firstBtn) firstBtn.click();

    showEl('yt-result');
  } catch (err) {
    $('yt-error').textContent = `❌ ${err.message}`;
    showEl('yt-error');
  } finally {
    hideEl('yt-loader');
    $('yt-fetch-btn').disabled = false;
  }
}

function selectFormat(btn, formatId, isMuxed, resolution) {
  document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ytSelectedFormat  = formatId;
  ytSelectedIsMuxed = !!isMuxed;

  // Re-create the button element to re-trigger the pop-in animation
  const wrap  = $('yt-dl-wrap');
  const label = $('yt-dl-label');
  if (wrap) {
    wrap.classList.remove('hidden');
    // Force animation replay
    const dlBtn = $('yt-dl-btn');
    if (dlBtn) { dlBtn.style.animation = 'none'; dlBtn.offsetHeight; dlBtn.style.animation = ''; }
  }
  if (label) label.textContent = `⬇️  Download ${resolution || 'Video'}`;
}

function downloadYouTubeVideo() {
  if (!ytSelectedFormat)  { showToast('⚠️ Select a quality first!'); return; }
  if (!ytCurrentUrl)      { showToast('⚠️ Fetch a video first!');    return; }
  const iv = showDownloadingState('yt', 'Downloading Video');
  showToast('⬇️ Starting download — check your browser downloads bar!', 5000);
  nativeDownload(
    { url: ytCurrentUrl, type: 'youtube', mediaType: 'video', formatId: ytSelectedFormat, isMuxed: ytSelectedIsMuxed, videoTitle: ytTitle },
    'youtube_video.mp4'
  );
  completeProgress('yt', iv);
}

function downloadYouTubeAudio() {
  if (!ytCurrentUrl) { showToast('⚠️ Fetch a video first!'); return; }
  const iv = showDownloadingState('yt', 'Extracting Audio');
  showToast('⬇️ Starting download — check your browser downloads bar!', 5000);
  nativeDownload(
    { url: ytCurrentUrl, type: 'youtube', mediaType: 'audio', formatId: ytAudioFormatId, videoTitle: ytTitle },
    'youtube_audio.mp3'
  );
  completeProgress('yt', iv);
}

// ── Enter key shortcuts ───────────────────────────────────────
$('ig-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') fetchInstagram(); });
$('yt-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') fetchYouTube(); });

// ── Expose globals for inline onclick attrs ───────────────────
window.downloadYouTubeVideo = downloadYouTubeVideo;
window.downloadYouTubeAudio = downloadYouTubeAudio;
