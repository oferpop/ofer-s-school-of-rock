// Accounts client: talks to the small local API in server.py.
// Every call is same-origin and cookie-based; nothing is stored in JS.

const BASE = "/api";

async function request(path, { method = "GET", body, keepalive = false } = {}) {
  const init = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    keepalive,
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(BASE + path, init);
  } catch {
    return { offline: true };
  }

  if (response.status === 204) return { status: 204, data: null };
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, data };
}

// A static host (no server.py) answers /api/... with 404 HTML or nothing at
// all, so both cases mean "accounts are not available here".
export async function probe() {
  const res = await request("/auth/me");
  if (res.offline || !res.data) return { available: false, user: null };
  if (res.status === 200 && "user" in res.data) return { available: true, user: res.data.user || null };
  return { available: false, user: null };
}

export async function signup({ name, email, password }) {
  const res = await request("/auth/signup", { method: "POST", body: { name, email, password } });
  return shape(res, 201);
}

export async function login({ email, password }) {
  const res = await request("/auth/login", { method: "POST", body: { email, password } });
  return shape(res, 200);
}

export async function logout() {
  const res = await request("/auth/logout", { method: "POST" });
  return { ok: !res.offline, offline: Boolean(res.offline) };
}

export async function pullState() {
  const res = await request("/state");
  if (res.offline) return { offline: true, state: null };
  if (res.status === 200) return { state: res.data?.state ?? null };
  if (res.status === 401) return { unauthorized: true, state: null };
  return { error: res.data?.message || "Could not load your saved data", state: null };
}

export async function pushState(state, { keepalive = false } = {}) {
  const res = await request("/state", { method: "PUT", body: { state }, keepalive });
  if (res.offline) return { offline: true };
  if (res.status === 204) return { ok: true };
  return { ok: false, message: res.data?.message || "Could not save to your account" };
}

function shape(res, successStatus) {
  if (res.offline) {
    return { offline: true, message: "Accounts need the local server: run `python3 server.py`." };
  }
  if (res.status === successStatus && res.data?.user) return { user: res.data.user };
  const fallback = res.status === 429 ? "Too many attempts — try again in a few minutes." : "Request failed.";
  return { error: res.data?.error || "request_failed", message: res.data?.message || fallback };
}
