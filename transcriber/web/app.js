const state = {
  user: null,
  jobId: null,
  songId: null,
  timer: null,
  startedAt: 0,
  failedJobId: null,
  songs: [],
  selected: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STAGE_LABELS = {
  queued: "Queued",
  converting: "Preparing audio",
  detecting: "Detecting notes",
  mapping: "Writing the draft tab",
  done: "Draft ready",
  failed: "Failed",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty body */ }
  if (!response.ok) {
    const error = new Error(data.detail || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showAuth() {
  state.user = null;
  state.songs = [];
  state.selected = null;
  state.jobId = null;
  state.failedJobId = null;
  clearTimeout(state.timer);
  $("#auth-view").hidden = false;
  $("#app-view").hidden = true;
  $("#userbox").hidden = true;
  $("#detail-card").hidden = true;
  $("#status-card").hidden = true;
  $("#songs").innerHTML = "";
}

function showApp(user) {
  state.user = user;
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  $("#userbox").hidden = false;
  $("#detail-card").hidden = true;
  $("#status-card").hidden = true;
  $("#who").textContent = `${user.username} · ${user.role}`;
  $("#limit-note").textContent = "3 uploads/day · 1 active job";
}

async function resumeActiveJob() {
  try {
    const data = await api("/api/jobs/active");
    if (!data.job) return;
    state.jobId = data.job.id;
    state.startedAt = performance.now();
    paintJob(data.job);
    pollJob(data.job.id);
  } catch (error) {
    if (error.status !== 401) toast(error.message);
  }
}

async function enterApp(user) {
  showApp(user);
  await refreshSongs();
  await resumeActiveJob();
}

async function loadMe() {
  try {
    const data = await api("/api/auth/me");
    await enterApp(data.user);
  } catch (error) {
    if (error.status !== 401) toast(error.message);
    showAuth();
  }
}

function badgeFor(song) {
  if (song.status === "failed") return '<span class="badge badge-failed">Failed</span>';
  if (song.status === "approved") return '<span class="badge badge-done">Approved</span>';
  if (!song.draft && song.status === "draft") return "";
  if (song.draft && song.status === "draft") return '<span class="badge badge-draft">Auto-generated draft</span>';
  return '<span class="badge">Processing</span>';
}

function renderSongs() {
  const box = $("#songs");
  box.innerHTML = "";
  $("#empty").hidden = state.songs.length > 0;
  for (const song of state.songs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "song-row";
    button.dataset.id = song.id;
    const owner = state.user?.role === "teacher" ? ` · ${song.owner_name}` : "";
    button.innerHTML = `
      <span class="song-main">
        <span class="song-title">${esc(song.title)}</span>
        <span class="song-sub">${esc(song.artist || "Unknown artist")}${esc(owner)} · ${esc(
          STAGE_LABELS[song.status] || song.status,
        )}</span>
      </span>
      <span class="song-badges">${badgeFor(song)}</span>`;
    button.addEventListener("click", () => openSong(song.id));
    box.appendChild(button);
  }
}

async function refreshSongs() {
  const data = await api("/api/songs");
  state.songs = data.songs;
  renderSongs();
}

async function openSong(id) {
  try {
    const song = await api(`/api/songs/${id}`);
    state.selected = song;
    $("#detail-title").textContent = song.title;
    $("#detail-meta").textContent = `${song.artist || "Unknown artist"} · ${STAGE_LABELS[song.status] || song.status}`;
    $("#detail-body").textContent = song.body || "This draft has no tab yet.";
    const source = $("#detail-source");
    if (song.source_url) {
      source.hidden = false;
      source.href = song.source_url;
    } else {
      source.hidden = true;
      source.removeAttribute("href");
    }
    const approve = $("#detail-approve");
    approve.hidden = !(state.user?.role === "teacher" && song.draft);
    $("#detail-card").hidden = false;
    $("#detail-card").scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    toast(error.message);
  }
}

function closeDetail() {
  state.selected = null;
  $("#detail-card").hidden = true;
}

async function approveSelected() {
  if (!state.selected) return;
  try {
    await api(`/api/songs/${state.selected.id}`, {
      method: "PATCH",
      body: JSON.stringify({ approve: true }),
    });
    toast("Draft approved.");
    await refreshSongs();
    await openSong(state.selected.id);
  } catch (error) {
    toast(error.message);
  }
}

async function deleteSelected() {
  if (!state.selected) return;
  if (!window.confirm("Delete this draft? This cannot be undone.")) return;
  try {
    await api(`/api/songs/${state.selected.id}`, { method: "DELETE" });
    closeDetail();
    await refreshSongs();
    toast("Draft deleted.");
  } catch (error) {
    toast(error.message);
  }
}

function paintJob(job) {
  const card = $("#status-card");
  card.hidden = false;
  const badge = $("#job-badge");
  badge.textContent = job.status === "failed" ? "Failed" : STAGE_LABELS[job.stage] || job.stage;
  badge.className = `badge ${job.status === "failed" ? "badge-failed" : job.status === "done" ? "badge-done" : ""}`;
  $("#job-stage").textContent = STAGE_LABELS[job.stage] || job.stage || "Working…";
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  $("#progress-fill").style.width = `${progress}%`;
  $("#progress").setAttribute("aria-valuenow", String(progress));
  const elapsed = state.startedAt ? ((performance.now() - state.startedAt) / 1000).toFixed(0) : "0";
  $("#job-meta").textContent = `${progress}% · ${elapsed}s elapsed`;
  const error = $("#job-error");
  if (job.status === "failed") {
    state.failedJobId = job.id || state.failedJobId;
    error.hidden = false;
    error.textContent = job.error || "The transcription failed.";
    $("#retry-btn").hidden = false;
  } else {
    state.failedJobId = null;
    error.hidden = true;
    $("#retry-btn").hidden = true;
  }
}

async function pollJob(jobId) {
  clearTimeout(state.timer);
  try {
    const job = await api(`/api/jobs/${jobId}`);
    paintJob(job);
    if (job.status === "done") {
      state.jobId = null;
      await refreshSongs();
      await openSong(job.song_id);
      toast("Draft ready in your library.");
      return;
    }
    if (job.status === "failed") {
      state.jobId = null;
      return;
    }
    state.timer = setTimeout(() => pollJob(jobId), 1000);
  } catch (error) {
    if (error.status === 401) {
      showAuth();
      return;
    }
    toast(error.message);
    state.timer = setTimeout(() => pollJob(jobId), 2500);
  }
}

async function startTranscription(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = $("#audio-input").files?.[0];
  if (!file) {
    toast("Choose an audio file first.");
    return;
  }
  if (file.size > 30 * 1024 * 1024) {
    toast("Audio must be smaller than 30 MB.");
    return;
  }
  const button = $("#upload-btn");
  button.disabled = true;
  const body = new FormData(form);
  try {
    const data = await api("/api/transcriptions", { method: "POST", body });
    state.jobId = data.job_id;
    state.songId = data.song_id;
    state.startedAt = performance.now();
    form.reset();
    $("#file-title").textContent = "Choose an audio file";
    $("#file-title").classList.remove("has-file");
    paintJob({ status: "queued", stage: "queued", progress: 0 });
    await refreshSongs();
    pollJob(data.job_id);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function retryJob() {
  const id = state.failedJobId;
  if (!id) {
    toast("Retry is only available after a failure on this page.");
    return;
  }
  try {
    await api(`/api/jobs/${id}/retry`, { method: "POST" });
    state.jobId = id;
    state.startedAt = performance.now();
    paintJob({ id, status: "queued", stage: "queued", progress: 0 });
    pollJob(id);
  } catch (error) {
    toast(error.message);
  }
}

function wire() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(data),
      });
      form.reset();
      await enterApp(result.user);
    } catch (error) {
      toast(error.message);
    }
  });

  $("#signup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify(data),
      });
      form.reset();
      await enterApp(result.user);
      toast("Welcome.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#logout").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    clearTimeout(state.timer);
    showAuth();
  });

  $("#upload-form").addEventListener("submit", startTranscription);
  $("#refresh").addEventListener("click", () => refreshSongs().catch((error) => toast(error.message)));
  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-approve").addEventListener("click", approveSelected);
  $("#detail-delete").addEventListener("click", deleteSelected);
  $("#retry-btn").addEventListener("click", retryJob);

  $("#audio-input").addEventListener("change", () => {
    const file = $("#audio-input").files?.[0];
    const label = $("#file-title");
    if (!file) {
      label.textContent = "Choose an audio file";
      label.classList.remove("has-file");
      return;
    }
    label.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    label.classList.add("has-file");
  });
}

wire();
loadMe();
