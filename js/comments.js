// Shared comments client. Reads are public; writing needs a signed-in session.

const BASE = "/api/comments";

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listComments(songId) {
  let response;
  try {
    response = await fetch(`${BASE}?song=${encodeURIComponent(songId)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { error: "Could not load comments — is the server running?" };
  }
  const data = await readJson(response);
  if (!response.ok || !data) return { error: data?.message || "Could not load comments." };
  return { comments: data.comments || [], authenticated: Boolean(data.authenticated) };
}

export async function addComment(songId, body) {
  let response;
  try {
    response = await fetch(BASE, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ songId, body }),
    });
  } catch {
    return { error: "Could not post — is the server running?" };
  }
  const data = await readJson(response);
  if (response.status === 201 && data?.comment) return { comment: data.comment };
  return { error: data?.message || "Could not post that comment." };
}

export async function deleteComment(id) {
  let response;
  try {
    response = await fetch(`${BASE}/${Number(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { error: "Could not delete — is the server running?" };
  }
  if (response.status === 204) return { ok: true };
  const data = await readJson(response);
  return { error: data?.message || "Could not delete that comment." };
}
