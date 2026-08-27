// Google Drive layer: sign-in (Google Identity Services token client) and the
// Drive REST calls the app needs, including the head-convention writes ported
// from scripts/lib/runfolder.py. Full `drive` scope (FC, 2026-08-27): the
// audio and yamls are created OUTSIDE the app (phone recorder, editors), which
// the narrow drive.file scope cannot see without per-file Picker taps.

import { archiveName } from "./core/runname.js";

export const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveError extends Error {}

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

export function initAuth(clientId) {
  if (!window.google?.accounts?.oauth2) throw new DriveError("Google Identity Services not loaded — check the network and reload");
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {}, // replaced per request
  });
}

// interactive=false tries a silent refresh (works once the user has consented;
// Google remembers the grant). Falls back to the account-chooser popup.
export function getToken({ interactive = false } = {}) {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return Promise.resolve(accessToken);
  if (!tokenClient) throw new DriveError("sign-in not initialized — set the OAuth Client ID in Settings");
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new DriveError(`sign-in failed: ${resp.error}`));
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" });
  });
}

export function signedIn() {
  return accessToken !== null && Date.now() < tokenExpiry - 60_000;
}

async function call(path, { method = "GET", query = {}, body = null, headers = {}, upload = false, raw = false } = {}) {
  const token = await getToken({ interactive: true });
  const base = upload ? UPLOAD : API;
  const qs = new URLSearchParams(query).toString();
  const url = `${base}${path}${qs ? "?" + qs : ""}`;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  if (r.status === 401) {
    accessToken = null; // expired mid-session: one silent retry
    return call(path, { method, query, body, headers, upload, raw });
  }
  if (!r.ok) throw new DriveError(`Drive ${method} ${path}: HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`);
  return raw ? r : r.json();
}

const FIELDS = "id,name,mimeType,modifiedTime,size,parents";

export async function listChildren(folderId, { extraQ = "", pageSize = 200 } = {}) {
  const files = [];
  let pageToken = "";
  do {
    const data = await call("/files", {
      query: {
        q: `'${folderId}' in parents and trashed=false${extraQ}`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize,
        pageToken,
        orderBy: "folder,name",
      },
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

export async function findChild(folderId, name, { folder = false } = {}) {
  const escaped = name.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const typeQ = folder ? ` and mimeType='${FOLDER_MIME}'` : "";
  const data = await call("/files", {
    query: { q: `'${folderId}' in parents and name='${escaped}' and trashed=false${typeQ}`, fields: `files(${FIELDS})` },
  });
  return (data.files || [])[0] || null;
}

export async function ensureFolder(parentId, name) {
  const existing = await findChild(parentId, name, { folder: true });
  if (existing) return existing.id;
  const meta = await call("/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    query: { fields: "id" },
  });
  return meta.id;
}

// path like "a/b/c" resolved from rootId ("root" = My Drive). Returns file meta.
export async function resolvePath(rootId, path) {
  let node = { id: rootId, mimeType: FOLDER_MIME, name: "(root)" };
  for (const segment of path.split("/").filter(Boolean)) {
    if (node.mimeType !== FOLDER_MIME) throw new DriveError(`'${node.name}' is a file, cannot descend into '${segment}'`);
    const next = await findChild(node.id, segment);
    if (!next) return null;
    node = next;
  }
  return node;
}

export async function downloadText(fileId) {
  const r = await call(`/files/${fileId}`, { query: { alt: "media" }, raw: true });
  return r.text();
}

export async function downloadBytes(fileId) {
  const r = await call(`/files/${fileId}`, { query: { alt: "media" }, raw: true });
  return new Uint8Array(await r.arrayBuffer());
}

function multipartBody(metadata, content, mime) {
  const boundary = "tsctBoundary" + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return { body, type: `multipart/related; boundary=${boundary}` };
}

export async function createFile(parentId, name, content, mime = "text/plain") {
  const { body, type } = multipartBody({ name, parents: [parentId] }, content, mime);
  return call("/files", { method: "POST", upload: true, query: { uploadType: "multipart", fields: FIELDS }, headers: { "Content-Type": type }, body });
}

export async function updateFile(fileId, content, mime = "text/plain") {
  return call(`/files/${fileId}`, { method: "PATCH", upload: true, query: { uploadType: "media", fields: FIELDS }, headers: { "Content-Type": mime }, body: content });
}

export async function rename(fileId, { name = null, addParent = null, removeParent = null }) {
  const query = { fields: "id,name" };
  if (addParent) query.addParents = addParent;
  if (removeParent) query.removeParents = removeParent;
  return call(`/files/${fileId}`, {
    method: "PATCH",
    query,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
}

// ---- head convention (runfolder.py port) --------------------------------
// Before replacing <name> in <dirId>, move the existing file into old/ beside
// it, renamed with its own modification timestamp. Returns the new file meta.
export async function writeWithHead(dirId, name, content, mime = "text/plain", log = () => {}) {
  const existing = await findChild(dirId, name);
  if (existing) {
    const oldDir = await ensureFolder(dirId, "old");
    const mtime = new Date(existing.modifiedTime);
    let archived = archiveName(name, mtime);
    if (await findChild(oldDir, archived)) archived = archiveName(name, mtime, true); // same-second collision
    await rename(existing.id, { name: archived, addParent: oldDir, removeParent: dirId });
    log(`♻️ previous ${name} kept as old/${archived}`);
  }
  return createFile(dirId, name, content, mime);
}

// metadata.yaml is a log: it accumulates calls in place (never archived).
export async function writeMetadata(dirId, name, data, yamlLib) {
  const existing = await findChild(dirId, name);
  if (existing) {
    let prior = {};
    try {
      prior = yamlLib.load(await downloadText(existing.id)) || {};
    } catch {
      prior = {};
    }
    const calls = [...(prior.calls || []), ...(data.calls || [])];
    const estimates = calls.map((c) => c.usd_estimate);
    data = {
      ...prior,
      ...data,
      calls,
      total_usd_estimate: estimates.every((e) => e !== null && e !== undefined) ? Math.round(estimates.reduce((a, b) => a + b, 0) * 10000) / 10000 : null,
    };
    return updateFile(existing.id, yamlLib.dump(data, { sortKeys: false }));
  }
  return createFile(dirId, name, yamlLib.dump(data, { sortKeys: false }));
}
