export async function apiGet(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw await buildApiError(response, path);
  }
  return parseApiJson(response, path);
}

export async function apiGetNullable(path) {
  const response = await fetch(path);
  if (!response.ok) {
    return null;
  }
  return parseApiJson(response, path).catch(() => null);
}

export async function apiPut(path, body) {
  return apiSend('PUT', path, body);
}

export async function apiPost(path, body) {
  return apiSend('POST', path, body);
}

export function fetchWorkspaceStatus() {
  return apiGet('/api/status');
}

export function fetchCapabilities() {
  return apiGet('/api/capabilities');
}

export function fetchProjectConfig(projectId, editId) {
  return apiGet(withEditQuery(`/api/projects/${encodeURIComponent(projectId)}/config`, editId));
}

export function fetchProjectColorArchive(projectId) {
  return apiGet(`/api/projects/${encodeURIComponent(projectId)}/color/archive`);
}

export function runProjectColorPreflight(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/color/preflight`, payload);
}

export function fetchProjectColorOverwritePreview(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/color/render-overwrite-preview`, payload);
}

export function saveProjectColorDrpSnapshot(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/color/drp-snapshot`, payload);
}

export function registerProjectColorDrpSnapshot(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/color/drp-snapshot/register`, payload);
}

export function saveProjectEditResolveSnapshot(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/edit/resolve-project-snapshot`, payload);
}

export function registerProjectEditResolveSnapshot(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/edit/resolve-project-snapshot/register`, payload);
}

export function fetchProjectEditResolveAssets(projectId) {
  return apiGet(`/api/projects/${encodeURIComponent(projectId)}/edit/resolve-assets`);
}

export function installProjectEditResolveAssets(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/edit/resolve-assets`, payload);
}

export function relinkProjectEditResolveMedia(projectId, payload = {}) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/edit/resolve-media-relink`, payload);
}

export function fetchWorkspaceStyleConfig() {
  return apiGet('/api/workspace/config/style-sources');
}

export function fetchWorkspaceEditRulesConfig() {
  return apiGet('/api/workspace/config/edit-rules');
}

export function fetchTranscriptGlossary() {
  return apiGet('/api/workspace/config/transcript-glossary');
}

export function fetchWorkspaceAsrConfig() {
  return apiGet('/api/workspace/config/asr');
}

export function confirmProjectChronology(projectId) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/chronology/confirm`, {});
}

export function updateProjectChronologyEvent(projectId, eventId, payload) {
  return apiPut(`/api/projects/${encodeURIComponent(projectId)}/chronology/events/${encodeURIComponent(eventId)}`, payload);
}

export function mergeProjectChronologyEvents(projectId, eventIds) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/chronology/events/merge`, { eventIds });
}

export function splitProjectChronologyEvent(projectId, eventId) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/chronology/events/${encodeURIComponent(eventId)}/split`, {});
}

export function fetchProjectReviews(projectId) {
  return apiGet(`/api/projects/${encodeURIComponent(projectId)}/reviews`);
}

export function fetchProjectProgress(projectId, pipelineKey = 'media-analyze') {
  return apiGetNullable(`/api/projects/${encodeURIComponent(projectId)}/progress/${encodeURIComponent(pipelineKey)}`);
}

export function fetchAnalyzeMonitor(projectId) {
  return apiGet(`/api/projects/${encodeURIComponent(projectId)}/monitor/analyze`);
}

export function fetchStyleMonitor(categoryId) {
  const query = categoryId ? `?categoryId=${encodeURIComponent(categoryId)}` : '';
  return apiGet(`/api/workspace/monitor/style-analysis${query}`);
}

export function saveProjectSection(projectId, sectionKey, payload) {
  return apiPut(
    withEditQuery(`/api/projects/${encodeURIComponent(projectId)}/config/${sectionKey}`, payload?.editId),
    payload,
  );
}

export function saveWorkspaceStyleConfig(payload) {
  return apiPut('/api/workspace/config/style-sources', payload);
}

export function saveWorkspaceEditRulesConfig(payload) {
  return apiPut('/api/workspace/config/edit-rules', payload);
}

export function saveTranscriptGlossary(payload) {
  return apiPut('/api/workspace/config/transcript-glossary', payload);
}

export function saveWorkspaceAsrConfig(payload) {
  return apiPut('/api/workspace/config/asr', payload);
}

export function resolveProjectReview(projectId, reviewId, payload) {
  return apiPost(`/api/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/resolve`, payload);
}

export function startJob(projectId, jobType, args = {}) {
  return apiPost('/api/jobs', { jobType, projectId, args });
}

export function startWorkspaceJob(jobType, args = {}) {
  return apiPost('/api/jobs', { jobType, args });
}

export function controlMl(action) {
  return apiPost(`/api/services/ml/${action}`, {});
}

async function apiSend(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw await buildApiError(response, path);
  }
  return parseApiJson(response, path);
}

function withEditQuery(path, editId) {
  if (!editId) return path;
  return `${path}?editId=${encodeURIComponent(editId)}`;
}

async function parseApiJson(response, path) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 120);
    throw new Error(`API ${path} returned non-JSON response: ${preview}`);
  }
}

async function buildApiError(response, path) {
  const text = await response.text();
  if (!text.trim()) {
    return new Error(`API ${path} failed with ${response.status}`);
  }
  try {
    const payload = JSON.parse(text);
    const error = new Error(payload?.error || payload?.message || text);
    if (payload && typeof payload === 'object') {
      error.code = payload.code;
      error.details = payload.details;
    }
    return error;
  } catch {
    return new Error(`API ${path} failed with ${response.status}: ${text.trim().slice(0, 240)}`);
  }
}
