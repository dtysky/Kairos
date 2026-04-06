export async function apiGet(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function apiGetNullable(path) {
  const response = await fetch(path);
  if (!response.ok) {
    return null;
  }
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

export function fetchProjectConfig(projectId) {
  return apiGet(`/api/projects/${encodeURIComponent(projectId)}/config`);
}

export function fetchWorkspaceStyleConfig() {
  return apiGet('/api/workspace/config/style-sources');
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
  return apiPut(`/api/projects/${encodeURIComponent(projectId)}/config/${sectionKey}`, payload);
}

export function saveWorkspaceStyleConfig(payload) {
  return apiPut('/api/workspace/config/style-sources', payload);
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
    throw new Error(await response.text());
  }
  return response.json();
}
