import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Badge, Drawer, Table } from 'antd';
import { Button, Card, Modal, Option, Select, Tag } from './ui-compat.tsx';
import './app.scss';
import './redesign.scss';
import { ConsoleSidebar } from './components/console-sidebar.tsx';
import { isProjectSwitchBlocked, useConsoleState } from './app-state.tsx';
import { buildChronologyEventPayload, filterChronologyEvents } from './chronology-view.ts';
import {
  controlMl,
  confirmProjectChronology,
  commitSpeechTranscriptReview,
  fetchAnalyzeMonitor,
  fetchCapabilities,
  fetchProjectColorArchive,
  fetchProjectColorOverwritePreview,
  fetchProjectConfig,
  fetchProjectProgress,
  fetchProjectReviews,
  fetchStyleMonitor,
  fetchWorkspaceEditRulesConfig,
  fetchWorkspaceStyleConfig,
  fetchWorkspaceStatus,
  fetchTranscriptGlossary,
  fetchWorkspaceAsrConfig,
  installProjectEditResolveAssets,
  registerProjectColorDrpSnapshot,
  registerProjectEditResolveSnapshot,
  relinkProjectEditResolveMedia,
  resolveProjectReview,
  mergeProjectChronologyEvents,
  runProjectColorPreflight,
  saveProjectColorDrpSnapshot,
  saveProjectEditResolveSnapshot,
  saveProjectSection,
  saveSpeechTranscriptReviewDraft,
  saveWorkspaceStyleConfig,
  saveTranscriptGlossary,
  saveWorkspaceAsrConfig,
  startJob,
  startWorkspaceJob,
  splitProjectChronologyEvent,
  updateProjectChronologyEvent,
} from './api.js';
import { EmptyPanel, MonitorPage } from './monitor-page.jsx';
import { resolveEditFlowSelections } from './edit-flow-state.js';
import {
  CaptureTimeOverridesEditor,
  ColorCurrentSummary,
  IngestRootClockEditor,
  ManualItineraryEditor,
  ProjectBriefEditor,
  ReviewQueuePanel,
  ScriptBriefEditor,
  StyleSourcesEditor,
  SpeechTranscriptReviewPanel,
  TranscriptGlossaryEditor,
  AsrConfigEditor,
  WorkflowPrompt,
} from './workspace-forms.jsx';

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { state: consoleState, dispatch } = useConsoleState();
  const [status, setStatus] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const storedProjectIdRef = React.useRef(window.localStorage.getItem('kairos.console.projectId') || '');
  const hydratedProjectSelectionRef = React.useRef(false);
  const projectLoadSequenceRef = React.useRef(0);
  const [projectId, setProjectId] = useState('');
  const [activeEditId, setActiveEditId] = useState(window.localStorage.getItem('kairos.console.editId') || 'main');
  const [config, setConfig] = useState(null);
  const [colorArchive, setColorArchive] = useState({ roots: [] });
  const [savedConfig, setSavedConfig] = useState(null);
  const [styleSources, setStyleSources] = useState(null);
  const [editRules, setEditRules] = useState(null);
  const [transcriptGlossary, setTranscriptGlossary] = useState(null);
  const [savedTranscriptGlossary, setSavedTranscriptGlossary] = useState(null);
  const [asrConfig, setAsrConfig] = useState(null);
  const [savedAsrConfig, setSavedAsrConfig] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [projectProgress, setProjectProgress] = useState(null);
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [workflowDialog, setWorkflowDialog] = useState(null);
  const [colorOverwriteDialog, setColorOverwriteDialog] = useState(null);
  const [editResolveAssetsResult, setEditResolveAssetsResult] = useState(null);
  const [editResolveAssetsError, setEditResolveAssetsError] = useState('');
  const [editRelinkResult, setEditRelinkResult] = useState(null);
  const [editRelinkError, setEditRelinkError] = useState('');

  useEffect(() => {
    refreshStatus();
    refreshStyleSources();
    refreshEditRules();
    refreshTranscriptGlossary();
    refreshAsrConfig();
    fetchCapabilities().then(setCapabilities).catch(handleError);
    const timer = window.setInterval(refreshStatus, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!status?.projects?.length) return;
    if (!hydratedProjectSelectionRef.current) {
      hydratedProjectSelectionRef.current = true;
      const nextProjectId = pickConsoleProjectId(status.projects, status.jobs, storedProjectIdRef.current);
      if (nextProjectId) {
        setProjectId(nextProjectId);
      }
      return;
    }
    if (projectId && status.projects.some(project => project.projectId === projectId)) {
      return;
    }
    const nextProjectId = pickConsoleProjectId(status.projects, status.jobs, storedProjectIdRef.current);
    if (nextProjectId) {
      setProjectId(nextProjectId);
    }
  }, [status, projectId]);

  useEffect(() => {
    if (!projectId) return;
    storedProjectIdRef.current = projectId;
    window.localStorage.setItem('kairos.console.projectId', projectId);
    refreshProject(projectId);
    refreshProjectProgress(projectId);
    const timer = window.setInterval(() => refreshProjectProgress(projectId), 4000);
    return () => window.clearInterval(timer);
  }, [projectId]);

  useEffect(() => {
    setEditResolveAssetsResult(null);
    setEditResolveAssetsError('');
    setEditRelinkResult(null);
    setEditRelinkError('');
  }, [projectId, activeEditId]);

  const projects = status?.projects || [];
  const duplicateProjectNames = useMemo(() => buildDuplicateProjectNameSet(projects), [projects]);
  const currentProject = projects.find(project => project.projectId === projectId) || null;
  const services = status?.services || [];
  const allJobs = status?.jobs || [];
  const activeJobs = useMemo(
    () => allJobs.filter(job => ['queued', 'running', 'blocked', 'awaiting_agent'].includes(job.status)),
    [allJobs],
  );
  const liveProjectJobs = useMemo(
    () => activeJobs.filter(job => job.projectId === projectId && ['queued', 'running'].includes(job.status)),
    [activeJobs, projectId],
  );
  const mlService = services.find(service => service.name === 'ml') || null;
  const dashboardService = services.find(service => service.name === 'dashboard') || null;
  const openReviewCount = reviews.filter(review => review.status === 'open').length;
  const hasUnsavedProjectConfig = useMemo(
    () => Boolean(config && savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig)),
    [config, savedConfig],
  );
  const hasUnsavedTranscriptGlossary = useMemo(
    () => Boolean(transcriptGlossary && savedTranscriptGlossary && JSON.stringify(transcriptGlossary) !== JSON.stringify(savedTranscriptGlossary)),
    [transcriptGlossary, savedTranscriptGlossary],
  );
  const hasUnsavedAsrConfig = useMemo(
    () => Boolean(asrConfig && savedAsrConfig && JSON.stringify(asrConfig) !== JSON.stringify(savedAsrConfig)),
    [asrConfig, savedAsrConfig],
  );

  useEffect(() => {
    dispatch({ type: 'set-dirty', section: 'project-config', dirty: hasUnsavedProjectConfig });
  }, [dispatch, hasUnsavedProjectConfig]);

  useEffect(() => {
    dispatch({ type: 'set-dirty', section: 'transcript-glossary', dirty: hasUnsavedTranscriptGlossary });
  }, [dispatch, hasUnsavedTranscriptGlossary]);

  useEffect(() => {
    dispatch({ type: 'set-dirty', section: 'asr-config', dirty: hasUnsavedAsrConfig });
  }, [dispatch, hasUnsavedAsrConfig]);

  useEffect(() => {
    dispatch({
      type: 'hydrate',
      payload: { projectId, config, jobs: allJobs, services, reviews },
    });
  }, [allJobs, config, dispatch, projectId, reviews, services]);

  useEffect(() => {
    if (!projectId || liveProjectJobs.length === 0) return undefined;
    const timer = window.setInterval(() => refreshProject(projectId), 4000);
    return () => window.clearInterval(timer);
  }, [projectId, liveProjectJobs.length]);

  const setProjectBrief = makeSectionSetter(setConfig, 'projectBrief');
  const setManualItinerary = makeSectionSetter(setConfig, 'manualItinerary');
  const setScriptBrief = makeSectionSetter(setConfig, 'scriptBrief');

  function openWorkflowDialog(dialog) {
    if (!dialog) return;
    setWorkflowDialog(dialog);
  }

  function requestProjectChange(nextProjectId) {
    if (!nextProjectId || nextProjectId === projectId) return;
    if (isProjectSwitchBlocked(consoleState.dirtySections)) {
      const confirmed = window.confirm('当前页面还有未保存的配置草稿。切换项目会丢失这些修改，仍要切换吗？');
      if (!confirmed) return;
    }
    projectLoadSequenceRef.current += 1;
    setConfig(null);
    setSavedConfig(null);
    setReviews([]);
    setColorArchive({ roots: [] });
    setProjectId(nextProjectId);
  }

  async function refreshStatus() {
    try {
      setStatus(await fetchWorkspaceStatus());
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshProject(nextProjectId, nextEditId = activeEditId) {
    const loadSequence = ++projectLoadSequenceRef.current;
    try {
      const [nextConfig, nextReviews, nextColorArchive] = await Promise.all([
        fetchProjectConfig(nextProjectId, nextEditId),
        fetchProjectReviews(nextProjectId),
        fetchProjectColorArchive(nextProjectId).catch(() => ({ roots: [] })),
      ]);
      if (loadSequence !== projectLoadSequenceRef.current) return;
      setConfig(nextConfig);
      setColorArchive(nextColorArchive || { roots: [] });
      setSavedConfig(nextConfig);
      setReviews(nextReviews.items || []);
    } catch (caught) {
      handleError(caught);
    }
  }

  async function recheckColorHost(nextProjectId, payload = {}, options = {}) {
    if (!nextProjectId) return;
    const silent = Boolean(options?.silent);
    const busyKey = payload?.rootId ? `color:preflight:${payload.rootId}` : 'color:preflight';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await runProjectColorPreflight(nextProjectId, payload);
      await refreshProject(nextProjectId);
      if (!silent) {
        setMessage(payload?.rootId ? `已刷新 ${payload.rootId} 的 Resolve host 诊断` : '已刷新 Resolve host 诊断');
      }
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function saveColorDrpSnapshot(payload = {}) {
    if (!projectId) return;
    const busyKey = payload?.rootId ? `color:drp-snapshot:${payload.rootId}` : 'color:drp-snapshot';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await saveProjectColorDrpSnapshot(projectId, payload);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage(payload?.retention === 'archive' ? '已归档 DRP 快照' : '已覆盖最新 DRP');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function registerColorDrpSnapshot(payload = {}) {
    if (!projectId) return;
    const busyKey = payload?.rootId ? `color:drp-register:${payload.rootId}` : 'color:drp-register';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await registerProjectColorDrpSnapshot(projectId, payload);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage('已登记外部 DRP');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function saveEditResolveSnapshot(payload = {}) {
    if (!projectId) return;
    const busyKey = 'edit:resolve-snapshot';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await saveProjectEditResolveSnapshot(projectId, payload);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage(payload?.retention === 'archive' ? '已归档剪辑 DRP 快照' : '已覆盖最新剪辑 DRP');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function registerEditResolveSnapshot(payload = {}) {
    if (!projectId) return;
    const busyKey = 'edit:resolve-register';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await registerProjectEditResolveSnapshot(projectId, payload);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage('已登记剪辑 DRP');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function installEditResolveAssets(payload = {}) {
    if (!projectId) return;
    const busyKey = 'edit:resolve-assets';
    setBusy(current => ({ ...current, [busyKey]: true }));
    setEditResolveAssetsError('');
    try {
      const result = await installProjectEditResolveAssets(projectId, payload);
      setEditResolveAssetsResult(result);
      await refreshProject(projectId);
      setMessage(formatResolveAssetsMessage(result));
      setError('');
    } catch (caught) {
      setEditResolveAssetsError(formatResolveAssetsError(caught));
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function relinkEditResolveMedia(payload = {}) {
    if (!projectId) return;
    const busyKey = 'edit:resolve-relink';
    setBusy(current => ({ ...current, [busyKey]: true }));
    setEditRelinkResult(null);
    setEditRelinkError('');
    try {
      const result = await relinkProjectEditResolveMedia(projectId, payload);
      setEditRelinkResult(result);
      setEditResolveAssetsResult(result?.resolveAssetsInstall || result?.hostSummary?.resolveAssetsInstall || null);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage(formatEditRelinkMessage(result));
      setError('');
    } catch (caught) {
      setEditRelinkError(formatEditRelinkError(caught));
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function refreshStyleSources() {
    try {
      setStyleSources(await fetchWorkspaceStyleConfig());
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshEditRules() {
    try {
      setEditRules(await fetchWorkspaceEditRulesConfig());
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshTranscriptGlossary() {
    try {
      const next = await fetchTranscriptGlossary();
      setTranscriptGlossary(next);
      setSavedTranscriptGlossary(next);
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshAsrConfig() {
    try {
      const next = await fetchWorkspaceAsrConfig();
      setAsrConfig(next);
      setSavedAsrConfig(next);
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function saveTranscriptGlossaryConfig() {
    if (!transcriptGlossary) return;
    const busyKey = 'workspace:transcript-glossary';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      const saved = await saveTranscriptGlossary(transcriptGlossary);
      setTranscriptGlossary(saved);
      setSavedTranscriptGlossary(saved);
      setMessage('已保存字幕共享词表');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function saveAsrConfig() {
    if (!asrConfig) return;
    const busyKey = 'workspace:asr-config';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      const saved = await saveWorkspaceAsrConfig(asrConfig);
      setAsrConfig(saved);
      setSavedAsrConfig(saved);
      await refreshStatus();
      setMessage('已保存 ASR 全局配置；运行时将严格使用所选 backend');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function refreshProjectProgress(nextProjectId) {
    try {
      setProjectProgress(await fetchProjectProgress(nextProjectId));
    } catch (caught) {
      handleError(caught);
    }
  }

  async function saveSection(sectionKey) {
    if (!projectId || !config) return;
    setBusy(current => ({ ...current, [sectionKey]: true }));
    try {
      const mapping = {
        'project-brief': config.projectBrief,
        'ingest-roots': config.ingestRoots,
        'manual-itinerary': config.manualItinerary,
        'edit-unit': config.editUnit,
        'script-brief': config.scriptBrief,
      };
      await saveProjectSection(projectId, sectionKey, mapping[sectionKey]);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage(`已保存 ${sectionKey}`);
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [sectionKey]: false }));
    }
  }

  async function saveEditUnitPayload(payload) {
    if (!projectId || !payload?.editId) return;
    setBusy(current => ({ ...current, 'edit-unit': true }));
    try {
      await saveProjectSection(projectId, 'edit-unit', payload);
      const nextEditId = payload.editId || 'main';
      window.localStorage.setItem('kairos.console.editId', nextEditId);
      setActiveEditId(nextEditId);
      await refreshProject(projectId, nextEditId);
      await refreshStatus();
      setMessage('已保存 Edit 初始化');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, 'edit-unit': false }));
    }
  }

  async function saveScriptBriefPayload(payload, busyKey, { successMessage = '', workflowDialog: nextWorkflowDialog = null } = {}) {
    if (!projectId) return;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await saveProjectSection(projectId, 'script-brief', payload);
      await refreshProject(projectId);
      await refreshStatus();
      if (nextWorkflowDialog) {
        openWorkflowDialog(nextWorkflowDialog);
        setMessage('');
      } else {
        setMessage(successMessage);
      }
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function saveScriptBriefReview() {
    const brief = config?.scriptBrief;
    if (!brief) return;
    const payload = buildReviewedScriptBriefPayload(brief);
    await saveScriptBriefPayload(
      payload,
      'script-brief',
      {
        workflowDialog: payload.workflowState === 'ready_to_prepare'
          ? buildScriptWorkflowDialog('ready_to_prepare')
          : null,
        successMessage: payload.workflowState === 'ready_to_prepare'
          ? ''
          : '当前仍在等待 Agent 生成 overview / brief',
      },
    );
  }

  async function saveScriptBriefEditRuleCategory(editRuleCategory) {
    const base = savedConfig?.scriptBrief || config?.scriptBrief;
    if (!base) return;
    await saveScriptBriefPayload(
      buildEditRuleSelectionScriptBriefPayload(base, editRuleCategory),
      'script-brief:edit-rule',
      {
        workflowDialog: editRuleCategory ? buildScriptWorkflowDialog('await_brief_draft') : null,
        successMessage: editRuleCategory ? '' : '已清除剪辑规则',
      },
    );
  }

  async function saveScriptBriefStyleCategory(styleCategory) {
    const base = savedConfig?.scriptBrief || config?.scriptBrief;
    if (!base) return;
    await saveScriptBriefPayload(
      buildStyleReferenceSelectionScriptBriefPayload(base, styleCategory),
      'script-brief:style',
      { successMessage: styleCategory ? '已保存风格档案' : '已清除风格档案' },
    );
  }

  async function authorizeScriptBriefRegeneration() {
    const base = savedConfig?.scriptBrief || config?.scriptBrief;
    if (!base?.editRuleCategory) return;
    await saveScriptBriefPayload(
      buildRegenerateScriptBriefPayload(base),
      'script-brief:regenerate',
      {
        workflowDialog: {
          title: '已授权重新生成 overview / brief',
          body: '下一步请回到 Agent，让它重新生成 material-overview.md 和初版 brief。',
          detail: '这次授权只生效一次；如果你之后又改了 brief，需要重新确认覆盖。',
        },
      },
    );
  }

  async function saveStyleLibrary() {
    if (!styleSources) return;
    const busyKey = 'style-sources';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await saveWorkspaceStyleConfig(styleSources);
      await refreshStyleSources();
      await refreshStatus();
      setMessage('已保存 workspace style-sources');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function runProjectWorkflow(jobType, args = {}) {
    if (!projectId) return;
    const busyKey = `job:${jobType}`;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      const colorAction = typeof args.action === 'string' && args.action.trim()
        ? args.action.trim()
        : 'prepare_root';
      const needsOverwritePreview = jobType === 'color'
        && ['execute_root', 'export_all_roots'].includes(colorAction)
        && args.overwriteConfirmed !== true;
      if (needsOverwritePreview) {
        const preview = await fetchProjectColorOverwritePreview(projectId, {
          ...args,
          action: colorAction,
        });
        if ((preview?.existingCount || 0) > 0) {
          setColorOverwriteDialog({
            jobType,
            args: {
              ...args,
              action: colorAction,
            },
            preview,
          });
          setMessage('');
          setError('');
          return;
        }
      }
      await startJob(projectId, jobType, args);
      await refreshProject(projectId).catch(() => undefined);
      await refreshStatus();
      setMessage(
        jobType === 'color' && args.rootId
            ? `已启动 color ${colorAction}：${args.rootId}${Array.isArray(args.clipKeys) && args.clipKeys.length > 0 ? ` / subset ${args.clipKeys.length}` : ''}${args.batchId ? ` / ${args.batchId}` : ''}`
            : jobType === 'color'
              ? `已启动 color ${colorAction}`
              : `已启动 ${jobType}`,
      );
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function runWorkspaceWorkflow(jobType, args = {}) {
    const busyKey = `job:${jobType}`;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await startWorkspaceJob(jobType, args);
      await refreshStatus();
      setMessage(`已启动 ${jobType}`);
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function confirmChronology() {
    if (!projectId) return;
    setBusy(current => ({ ...current, 'chronology:confirm': true }));
    try {
      await confirmProjectChronology(projectId);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage('Chronology 已确认');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, 'chronology:confirm': false }));
    }
  }

  async function saveChronologyEvent(eventId, payload) {
    if (!projectId || !eventId) return;
    const busyKey = `chronology:event:${eventId}`;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await updateProjectChronologyEvent(projectId, eventId, payload);
      await refreshProject(projectId);
      setMessage('Chronology event 已更新');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function mergeChronologyEvents(eventIds) {
    if (!projectId || eventIds.length < 2) return;
    setBusy(current => ({ ...current, 'chronology:merge': true }));
    try {
      await mergeProjectChronologyEvents(projectId, eventIds);
      await refreshProject(projectId);
      setMessage('Chronology events 已合并');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, 'chronology:merge': false }));
    }
  }

  async function splitChronologyEvent(eventId) {
    if (!projectId || !eventId) return;
    const busyKey = `chronology:split:${eventId}`;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await splitProjectChronologyEvent(projectId, eventId);
      await refreshProject(projectId);
      setMessage('Chronology event 已拆分');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function controlMlService(action) {
    const busyKey = `ml:${action}`;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await controlMl(action);
      await refreshStatus();
      setMessage(`ML ${action} 完成`);
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function resolveReview(reviewId, overrides = {}) {
    if (!projectId) return;
    const target = reviews.find(review => review.id === reviewId);
    if (!target) return;
    try {
      await resolveProjectReview(projectId, reviewId, {
        note: target.note,
        fields: (target.fields || []).map(field => ({ key: field.key, value: field.value })),
        status: 'resolved',
        ...overrides,
      });
      await refreshProject(projectId);
      if (target.kind === 'transcript-correction') {
        await refreshTranscriptGlossary();
      }
      setMessage(`已处理 review：${target.title}`);
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function commitSpeechReview(payload) {
    if (!projectId) return;
    const busyKey = 'chronology:speech-transcript-review';
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await commitSpeechTranscriptReview(projectId, payload);
      await refreshProject(projectId);
      setMessage('口播与字幕审查已提交，spans 已更新为 fresh');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, [busyKey]: false }));
    }
  }

  async function saveSpeechReviewDraft(payload) {
    if (!projectId) return null;
    return saveSpeechTranscriptReviewDraft(projectId, payload);
  }

  function handleError(caught) {
    const nextMessage = caught instanceof Error ? caught.message : String(caught);
    setError(nextMessage);
  }

  return (
    <div className={`console-shell${consoleState.sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <ConsoleSidebar />
      <div className="shell-main">
        <header className="workspace-bar">
          <div className="workspace-context">
            <div className="eyebrow">Kairos Supervisor</div>
            <div className="workspace-title-line">
              <h1>{currentProject?.project?.name || 'Kairos Console'}</h1>
              {hasUnsavedProjectConfig ? <Tag color="warning">未保存</Tag> : null}
            </div>
            {currentProject?.projectId ? <div className="muted workspace-project-id">{currentProject.projectId}</div> : null}
          </div>
          <div className="workspace-actions">
            <select value={projectId} onChange={event => requestProjectChange(event.target.value)} aria-label="当前项目">
              {projects.map(project => (
                <option key={project.projectId} value={project.projectId}>
                  {formatProjectOptionLabel(project, duplicateProjectNames)}
                </option>
              ))}
            </select>
            <div className="service-pills">
              <Tag color={dashboardService?.status === 'running' ? 'success' : 'default'}>{`Supervisor ${dashboardService?.status || 'unknown'}`}</Tag>
              <Tag color={mlService?.status === 'running' ? 'processing' : 'default'}>{`ML ${mlService?.status || 'unknown'}`}</Tag>
              <Badge count={activeJobs.length + openReviewCount} size="small" overflowCount={99}>
                <Button
                  type="default"
                  onClick={() => dispatch({ type: 'set-task-center-open', open: true })}
                >
                  任务中心
                </Button>
              </Badge>
            </div>
          </div>
        </header>

        <main className="shell-content">
          {message ? <div className="message-banner">{message}</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}

          <Routes>
            <Route path="/" element={<OverviewPage currentProject={currentProject} activeJobs={activeJobs} services={services} projectProgress={projectProgress} openReviewCount={openReviewCount} />} />
            <Route path="/ingest-gps" element={<IngestGpsPage projectId={projectId} config={config} capabilities={capabilities} jobs={allJobs} setProjectBrief={setProjectBrief} setManualItinerary={setManualItinerary} saveSection={saveSection} busy={busy} reviews={reviews} setReviews={setReviews} resolveReview={resolveReview} onRunIngest={() => runProjectWorkflow('ingest')} onRunGpsRefresh={() => runProjectWorkflow('gps-refresh')} />} />
            <Route path="/color" element={<ColorPage projectId={projectId} config={config} colorArchive={colorArchive} capabilities={capabilities} jobs={allJobs} setProjectBrief={setProjectBrief} saveSection={saveSection} busy={busy} onRunColorAction={args => runProjectWorkflow('color', args)} onRequestHostPreflight={(payload, options) => recheckColorHost(projectId, payload, options)} onSaveDrpSnapshot={saveColorDrpSnapshot} onRegisterDrpSnapshot={registerColorDrpSnapshot} />} />
            <Route path="/analyze/monitor" element={<Navigate to="/analyze" replace />} />
            <Route path="/analyze" element={<AnalyzePage projectId={projectId} projectProgress={projectProgress} activeJobs={activeJobs} capabilities={capabilities} busy={busy} onRun={() => runProjectWorkflow('analyze')} />} />
            <Route path="/chronology" element={<ChronologyPage projectId={projectId} config={config?.chronology} pharosContext={config?.pharosContext} spans={config?.spans} reviews={reviews} setReviews={setReviews} resolveReview={resolveReview} capabilities={capabilities} jobs={allJobs} busy={busy} onSaveSpeechReviewDraft={saveSpeechReviewDraft} onCommitSpeechReview={commitSpeechReview} onRunSpatialRefresh={() => runProjectWorkflow('spatial-refresh')} onRunSpanRebuild={(args = {}) => runProjectWorkflow('span-rebuild', args)} onRunChronologyBuild={() => runProjectWorkflow('chronology-build')} onConfirm={confirmChronology} onSaveEvent={saveChronologyEvent} onMergeEvents={mergeChronologyEvents} onSplitEvent={splitChronologyEvent} />} />
            <Route path="/style/monitor/:categoryId?" element={<StyleMonitorRedirect />} />
            <Route path="/style" element={<StylePage config={styleSources} capabilities={capabilities} jobs={allJobs} setStyleSources={setStyleSources} onSave={saveStyleLibrary} busy={busy} onRun={categoryId => runWorkspaceWorkflow('style-analysis', categoryId ? { categoryId } : {})} location={location} history={{ push: navigate }} />} />
            <Route path="/script" element={<Navigate to="/edit" replace />} />
            <Route path="/edit" element={<EditFlowPage config={config} activeEditId={activeEditId} editFlowPlan={config?.editFlowPlan} editFlowRuns={config?.editFlowRuns} capabilities={capabilities} editRules={editRules} styleSources={styleSources} busy={busy} jobs={allJobs} onSaveEditUnit={saveEditUnitPayload} onSaveResolveSnapshot={saveEditResolveSnapshot} onRegisterResolveSnapshot={registerEditResolveSnapshot} onInstallResolveAssets={installEditResolveAssets} onRelinkResolveMedia={relinkEditResolveMedia} editResolveAssetsResult={editResolveAssetsResult} editResolveAssetsError={editResolveAssetsError} editRelinkResult={editRelinkResult} editRelinkError={editRelinkError} />} />
            <Route path="/timeline-export" element={<TimelineExportPage capabilities={capabilities} />} />
            <Route path="/project" element={<ProjectPage services={services} busy={busy} onControlMl={controlMlService} reviews={reviews} setReviews={setReviews} resolveReview={resolveReview} currentProject={currentProject} asrConfig={asrConfig} setAsrConfig={setAsrConfig} onSaveAsrConfig={saveAsrConfig} transcriptGlossary={transcriptGlossary} setTranscriptGlossary={setTranscriptGlossary} onSaveTranscriptGlossary={saveTranscriptGlossaryConfig} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      <Drawer
        title="任务中心"
        width={420}
        open={consoleState.taskCenterOpen}
        onClose={() => dispatch({ type: 'set-task-center-open', open: false })}
      >
        <div className="task-center-section">
          <div className="section-header"><h3>活跃任务</h3><Tag>{activeJobs.length}</Tag></div>
          {activeJobs.length === 0 ? <p className="muted">当前没有活跃任务。</p> : activeJobs.map(job => (
            <div key={job.jobId} className="task-center-row">
              <div><strong>{job.jobType}</strong><span>{job.projectId || 'workspace'}</span></div>
              <Tag>{job.status}</Tag>
            </div>
          ))}
        </div>
        <div className="task-center-section">
          <div className="section-header"><h3>待处理 Review</h3><Tag>{openReviewCount}</Tag></div>
          {reviews.filter(review => review.status === 'open').slice(0, 12).map(review => (
            <div key={review.id} className="task-center-row">
              <div><strong>{review.title}</strong><span>{review.stage || review.kind || 'review'}</span></div>
            </div>
          ))}
          {openReviewCount === 0 ? <p className="muted">当前没有待处理 Review。</p> : null}
        </div>
      </Drawer>

      <Modal show={Boolean(workflowDialog)} title={workflowDialog?.title || ''} showClose closeOnClickBg cancel={() => setWorkflowDialog(null)} actions={<div className="actions modal-actions"><Button type="primary" onClick={() => setWorkflowDialog(null)}>{workflowDialog?.confirmLabel || '知道了'}</Button></div>}>
        <div className="modal-copy"><p>{workflowDialog?.body}</p>{workflowDialog?.detail ? <p>{workflowDialog.detail}</p> : null}</div>
      </Modal>
      <Modal show={Boolean(colorOverwriteDialog)} title="确认覆盖 Color 输出" width={720} showClose closeOnClickBg cancel={() => setColorOverwriteDialog(null)} actions={<div className="actions modal-actions"><Button type="default" onClick={() => setColorOverwriteDialog(null)}>取消</Button><Button type="primary" onClick={() => { const dialog = colorOverwriteDialog; setColorOverwriteDialog(null); if (!dialog) return; runProjectWorkflow(dialog.jobType, { ...dialog.args, overwriteConfirmed: true, overwritePlanHash: dialog.preview?.overwritePlanHash }); }}>确认覆盖并导出</Button></div>}>
        <div className="modal-copy">
          <p>{`将替换 ${colorOverwriteDialog?.preview?.existingCount || 0} 个已有目标，覆盖范围由当前预览 hash 锁定。`}</p>
          <p>{`输出 root：${colorOverwriteDialog?.preview?.outputRoot || '多个 roots'}`}</p>
          <p>Resolve 会按 raw 父目录拆临时时间线，直接渲染到最终 root/day 目录。</p>
          <div className="color-overwrite-preview-list">{(colorOverwriteDialog?.preview?.byDirectory || []).slice(0, 12).map(item => <div key={item.directory || 'root'} className="color-overwrite-preview-row"><span>{item.directory || '(root)'}</span><strong>{`${item.existingCount}/${item.clipCount}`}</strong></div>)}</div>
          {(colorOverwriteDialog?.preview?.duplicateStemGroups || []).length > 0 ? <p>{`检测到 ${colorOverwriteDialog.preview.duplicateStemGroups.length} 组同目录重名 stem；导出会在启动 Resolve 前阻塞，请先处理源文件名。`}</p> : null}
        </div>
      </Modal>
    </div>
  );
}

function OverviewPage({ currentProject, activeJobs, services, projectProgress, openReviewCount }) {
  const workflow = [
    { path: '/ingest-gps', label: '导入 / GPS', state: '准备' },
    { path: '/analyze', label: 'Analyze', state: projectProgress?.status || '待运行' },
    { path: '/chronology', label: '编年史', state: '待审查' },
    { path: '/edit', label: '剪辑流', state: '待进入' },
    { path: '/timeline-export', label: '时间线 / 导出', state: '待进入' },
  ];
  const runningServices = services.filter(service => service.status === 'running').length;
  const healthTone = activeJobs.some(job => ['blocked', 'failed'].includes(job.status)) ? 'warning' : 'success';

  return (
    <div className="route-page overview-page">
      <RouteIntro title="总览" subtitle="只呈现当前最需要关注的状态、任务与下一步。" />
      <section className="overview-hero">
        <div className="overview-health-copy">
          <div className="eyebrow">Project health</div>
          <h2>{currentProject?.project?.name || '当前项目'}</h2>
          <p>{projectProgress?.stepLabel || (activeJobs.length > 0 ? '有任务正在运行' : '当前工作区安静，可以继续下一阶段')}</p>
        </div>
        <div className="overview-metrics">
          <div><span>健康</span><strong><Tag color={healthTone}>{healthTone === 'success' ? '稳定' : '需关注'}</Tag></strong></div>
          <div><span>活跃任务</span><strong>{activeJobs.length}</strong></div>
          <div><span>待审查</span><strong>{openReviewCount}</strong></div>
          <div><span>在线服务</span><strong>{`${runningServices}/${services.length}`}</strong></div>
        </div>
      </section>

      <Card className="panel overview-workflow-panel">
        <div className="section-header"><div><div className="eyebrow">Workflow</div><h2>主流程</h2></div><span className="muted">Color 为素材准备的可选增强；Style 作为 Workspace 输入接入 Edit。</span></div>
        <div className="overview-workflow-track">
          {workflow.map((step, index) => (
            <React.Fragment key={step.path}>
              <Link to={step.path} className="overview-workflow-step">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{step.label}</strong>
                <small>{step.state}</small>
              </Link>
              {index < workflow.length - 1 ? <div className="overview-workflow-line" /> : null}
            </React.Fragment>
          ))}
        </div>
      </Card>

      <div className="overview-focus-grid">
        <Card className="panel">
          <div className="section-header"><h2>当前任务</h2><Tag>{activeJobs.length}</Tag></div>
          {activeJobs.length === 0 ? <p className="overview-empty-copy">没有活跃任务。下一步从左侧主流程进入。</p> : activeJobs.slice(0, 4).map(job => (
            <div key={job.jobId} className="job-item"><div><strong>{job.jobType}</strong><div className="muted">{job.progress?.stepLabel || job.projectId || 'workspace'}</div></div><Tag>{job.status}</Tag></div>
          ))}
        </Card>
        <Card className="panel">
          <div className="section-header"><h2>最近进度</h2>{projectProgress ? <Tag>{projectProgress.status || 'cached'}</Tag> : null}</div>
          {projectProgress ? <div className="overview-progress-summary"><strong>{projectProgress.pipelineLabel || 'media-analyze'}</strong><span>{projectProgress.stepLabel || projectProgress.step || '未标记阶段'}</span><small>{`${projectProgress.current || 0}/${projectProgress.total || 0}`}</small></div> : <p className="overview-empty-copy">当前项目没有可展示的 durable progress。</p>}
        </Card>
      </div>
    </div>
  );
}

function IngestGpsPage({
  projectId,
  config,
  capabilities,
  jobs,
  setProjectBrief,
  setManualItinerary,
  saveSection,
  busy,
  reviews,
  setReviews,
  resolveReview,
  onRunIngest,
  onRunGpsRefresh,
}) {
  const [activeSection, setActiveSection] = useState('sources');
  if (!config) {
    return (
      <div className="route-page">
        <EmptyPanel label="当前项目配置尚未加载完成。" />
      </div>
    );
  }
  return (
    <div className="route-page ingest-gps-page">
      <RouteIntro title="导入与 GPS" subtitle="先维护事实，再从固定运行栏显式刷新资产与空间缓存。" />
      <div className="section-tabs" role="tablist" aria-label="导入与 GPS 分区">
        {[
          ['sources', '素材源'],
          ['itinerary', '行程 / GPS'],
          ['time', '时间校正'],
          ['review', 'Review'],
        ].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={activeSection === key} className={activeSection === key ? 'is-active' : ''} onClick={() => setActiveSection(key)}>{label}</button>
        ))}
      </div>
      <div className="ingest-section-body">
        {activeSection === 'sources' ? <ProjectBriefEditor config={config.projectBrief} pharosStatus={config.pharosStatus} summaries={config.ingestRootSummaries || []} setConfig={setProjectBrief} onSave={() => saveSection('project-brief')} busy={busy['project-brief']} /> : null}
        {activeSection === 'itinerary' ? <ManualItineraryEditor config={config.manualItinerary} setConfig={setManualItinerary} onSave={() => saveSection('manual-itinerary')} busy={busy['manual-itinerary']} /> : null}
        {activeSection === 'time' ? <><IngestRootClockEditor config={config.projectBrief} summaries={config.ingestRootSummaries || []} setConfig={setProjectBrief} onSave={() => saveSection('project-brief')} busy={busy['project-brief']} /><CaptureTimeOverridesEditor config={config.manualItinerary} setConfig={setManualItinerary} onSave={() => saveSection('manual-itinerary')} busy={busy['manual-itinerary']} /></> : null}
        {activeSection === 'review' ? <ReviewQueuePanel reviews={reviews} setReviews={setReviews} onResolve={resolveReview} title="导入 / GPS Review" emptyLabel="当前没有 ingest / gps 相关 review。" filter={review => review.kind !== 'capture-time-correction' && ['project-init', 'ingest', 'gps-refresh'].includes(review.stage)} /> : null}
      </div>
      <div className="ingest-run-dock">
        <IngestGpsActionPanel projectId={projectId} capabilities={capabilities} jobs={jobs} busy={busy} onRunIngest={onRunIngest} onRunGpsRefresh={onRunGpsRefresh} />
      </div>
    </div>
  );
}

function IngestGpsActionPanel({
  projectId,
  capabilities,
  jobs,
  busy,
  onRunIngest,
  onRunGpsRefresh,
}) {
  const ingestCapability = capabilities?.jobs?.find(job => job.jobType === 'ingest');
  const gpsRefreshCapability = capabilities?.jobs?.find(job => job.jobType === 'gps-refresh');
  const workflowJobs = (jobs || [])
    .filter(job => ['ingest', 'gps-refresh'].includes(job.jobType))
    .filter(job => !projectId || job.projectId === projectId);
  const activeIngestJobs = workflowJobs.filter(job => job.jobType === 'ingest' && isLiveSupervisorJob(job));
  const activeGpsRefreshJobs = workflowJobs.filter(job => job.jobType === 'gps-refresh' && isLiveSupervisorJob(job));
  const latestJob = workflowJobs[0] || null;
  const canRunIngest = Boolean(projectId)
    && ingestCapability?.supported !== false
    && !busy['job:ingest']
    && activeIngestJobs.length === 0;
  const canRunGpsRefresh = Boolean(projectId)
    && gpsRefreshCapability?.supported !== false
    && !busy['job:gps-refresh']
    && activeGpsRefreshJobs.length === 0;

  return (
    <Card className="panel ingest-action-panel">
      <div className="ingest-action-main">
        <div>
          <div className="eyebrow">Run controls</div>
          <h2>导入与 GPS 刷新</h2>
        </div>
        <div className="actions">
        <Button
          type={canRunIngest ? 'primary' : 'disabled'}
          disabled={!canRunIngest}
          onClick={onRunIngest}
        >
          {busy['job:ingest'] ? '启动中…' : activeIngestJobs.length > 0 ? 'Ingest 运行中…' : '运行 Ingest'}
        </Button>
        <Button
          type={canRunGpsRefresh ? 'default' : 'disabled'}
          disabled={!canRunGpsRefresh}
          onClick={onRunGpsRefresh}
        >
          {busy['job:gps-refresh'] ? '启动中…' : activeGpsRefreshJobs.length > 0 ? 'GPS 刷新中…' : '刷新 GPS 缓存'}
        </Button>
        </div>
      </div>
      <div className="ingest-action-status">
        {latestJob ? (
          <div className="ingest-action-job">
            <div>
              <strong>{describeIngestGpsJobTitle(latestJob)}</strong>
              <div className="muted">{describeIngestGpsJob(latestJob)}</div>
              {latestJob.resultPath ? <div className="muted">{`结果：${latestJob.resultPath}`}</div> : null}
            </div>
            <Tag>{formatIngestGpsJobStatus(latestJob.status)}</Tag>
          </div>
        ) : (
          <div className="ingest-action-job">
            <div>
              <strong>尚未运行</strong>
              <div className="muted">修改素材 Root、FlightRecord、时间校正或行程后，先运行 Ingest 再进入 Analyze。</div>
            </div>
            <Tag>idle</Tag>
          </div>
        )}
        {latestJob?.blockers?.length ? (
          <div className="ingest-action-blocker">
            {`Blockers：${latestJob.blockers.join('；')}`}
          </div>
        ) : null}
        <Tag>{latestJob ? formatIngestGpsJobStatus(latestJob.status) : '未运行'}</Tag>
      </div>
    </Card>
  );
}

function ColorPage({
  projectId,
  config,
  colorArchive,
  capabilities,
  jobs,
  setProjectBrief,
  saveSection,
  busy,
  onRunColorAction,
  onRequestHostPreflight,
  onSaveDrpSnapshot,
  onRegisterDrpSnapshot,
}) {
  if (!config) {
    return (
      <div className="route-page">
        <EmptyPanel label="当前项目配置尚未加载完成。" />
      </div>
    );
  }
  const colorCapability = resolveColorCapability(capabilities);
  const colorBlocked = colorCapability?.supported === false;
  const colorCapabilityDetail = colorCapability?.note || colorCapability?.reason || colorCapability?.message || '';
  return (
    <div className="route-page">
      <RouteIntro
        title="达芬奇调色"
        subtitle="从 Root 状态开始，集中完成 Resolve 准备、分组同步、执行与验证。"
      />
      {colorBlocked ? (
        <WorkflowPrompt
          eyebrow="Blocked"
          title="当前 capability 不支持 color"
          body="capabilities 已明确标记 `color` 不支持。这个页面仍可查看和编辑配置，但不会提供运行入口，也不会影响主链。"
          tone="error"
          detail={colorCapabilityDetail || '请先确认后端是否已经开放 color 能力。'}
        />
      ) : colorCapabilityDetail ? (
        <section className="color-runtime-strip" title={colorCapabilityDetail}>
          <div>
            <div className="eyebrow">Resolve runtime</div>
            <strong>同机 Resolve 后端已连接</strong>
          </div>
          <Tag color="success">Root 闭环可用</Tag>
          <span>Relink → Prepare → Groups → Execute → Validate</span>
        </section>
      ) : null}
      <ColorCurrentSummary
        config={config}
        colorArchive={colorArchive}
        capability={colorCapability}
        projectId={projectId}
        jobs={jobs}
        setProjectBrief={setProjectBrief}
        onSaveProjectRoots={() => saveSection('project-brief')}
        busy={busy}
        onRunColorAction={onRunColorAction}
        onRequestHostPreflight={onRequestHostPreflight}
        onSaveDrpSnapshot={onSaveDrpSnapshot}
        onRegisterDrpSnapshot={onRegisterDrpSnapshot}
      />
    </div>
  );
}

function AnalyzePage({ projectId, projectProgress, activeJobs, capabilities, busy, onRun }) {
  const analyzeJobs = activeJobs.filter(job => job.projectId === projectId && job.jobType === 'analyze');
  const analyzeCapability = capabilities?.jobs?.find(job => job.jobType === 'analyze');
  const canStartAnalyze = Boolean(projectId)
    && !busy['job:analyze']
    && analyzeJobs.length === 0
    && analyzeCapability?.supported !== false;
  return (
    <MonitorLoader
      kind="analyze"
      projectId={projectId}
      emptyLabel="当前项目还没有可展示的 Analyze 监控数据。"
      toolbar={model => (
        <>
          <div className="monitor-toolbar-group">
	          <Button
	            type={canStartAnalyze && model?.asr?.available !== false ? 'primary' : 'disabled'}
	            disabled={!canStartAnalyze || model?.asr?.available === false}
	            onClick={onRun}
	          >
	            {busy['job:analyze'] ? '启动中…' : analyzeJobs.length > 0 ? 'Analyze 运行中…' : model?.asr?.available === false ? 'ASR 配置阻塞' : '启动 Analyze'}
	          </Button>
	          </div>
	          <div className="monitor-toolbar-meta">
	            <span>{`活跃 analyze ${analyzeJobs.length}`}</span>
	            {renderAnalyzeToolbarMeta(model, projectProgress)}
	          </div>
        </>
      )}
      afterMonitor={model => (
        <AnalyzeAfterMonitor
          model={model}
	          projectProgress={projectProgress}
	          analyzeJobs={analyzeJobs}
	        />
      )}
    />
  );
}

function AnalyzeAfterMonitor({ model, projectProgress, analyzeJobs }) {
  const progress = model?.progress || projectProgress || null;
  const pipelines = model?.pipelines || [];
  const coarsePipeline = pipelines.find(item => item.kind === 'coarse-scan') || null;
  const audioPipeline = pipelines.find(item => item.kind === 'audio-analysis') || null;
  const finePipeline = pipelines.find(item => item.kind === 'fine-scan') || null;
  const asrReleased = model?.asr?.lifecycle === 'released';
  const asrBlocked = model?.asr?.lifecycle === 'unavailable'
    || (!model?.asr?.lifecycle && model?.asr?.available === false);

  return (
    <>
      <Card className={`panel analyze-asr-panel ${asrBlocked ? 'analyze-asr-panel-blocked' : ''}`}>
        <div className="section-header">
          <div>
            <h2>ASR 运行配置</h2>
            <p className="muted">这是实际运行路由，不是偏好顺序；所选 backend 不可用时不会改跑另一个 backend。</p>
          </div>
          <Tag color={asrReleased || model?.asr?.available === true ? 'success' : asrBlocked ? 'error' : 'default'}>
            {asrReleased ? '已完成并释放' : model?.asr?.available === true ? '可用' : asrBlocked ? '已阻塞' : '待启动检查'}
          </Tag>
        </div>
        <div className="asr-runtime-grid">
          <div><span>配置 Backend</span><strong>{formatAsrBackend(model?.asr?.configuredBackend)}</strong></div>
          <div><span>实际 Backend</span><strong>{formatAsrBackend(model?.asr?.actualBackend)}</strong></div>
          <div><span>运行 Provider</span><strong>{model?.asr?.provider || (asrReleased ? '已卸载' : '尚未装载')}</strong></div>
          <div><span>时间戳</span><strong>{model?.asr?.timestampMode || (asrReleased ? '字级对齐已完成' : '启动时检查')}</strong></div>
          <div><span>平台运行时</span><strong>{model?.asr?.runtimeVariant || '启动时检查'}</strong></div>
          <div><span>计算设备</span><strong>{model?.asr?.device || (asrReleased ? '显存已释放' : '启动时检查')}</strong></div>
        </div>
        {model?.asr?.modelRef ? <div className="asr-path-row"><span>ASR 模型</span><code title={model.asr.modelRef}>{model.asr.modelRef}</code><Tag color={model?.asr?.modelAvailable ? 'success' : 'error'}>{model?.asr?.modelAvailable ? 'ready' : 'missing'}</Tag></div> : null}
        {model?.asr?.alignerModelRef ? <div className="asr-path-row"><span>Aligner</span><code title={model.asr.alignerModelRef}>{model.asr.alignerModelRef}</code><Tag color={model?.asr?.alignerAvailable ? 'success' : 'error'}>{model?.asr?.alignerAvailable ? 'ready' : 'missing'}</Tag></div> : null}
        {model?.asr?.statusDetail ? <div className="pipeline-footnote">{model.asr.statusDetail}</div> : null}
        {model?.asr?.blocker && !asrReleased ? <div className={asrBlocked ? 'error-banner' : 'pipeline-footnote'}>{model.asr.blocker}</div> : null}
      </Card>
      <div className="card-grid card-grid-two">
      <Card className="panel">
        <div className="section-header">
          <h2>Analyze 并发阶段</h2>
          <Tag>{progress?.stepLabel || progress?.stepKey || projectProgress?.stepLabel || projectProgress?.step || 'idle'}</Tag>
        </div>
        <div className="stack-list">
          <AnalyzePipelineSection
            title="粗扫队列"
            pipeline={coarsePipeline}
            emptyLabel="进入 coarse-scan 后，这里会显示素材级 worker、排队和 prepared checkpoint 状态。"
          />
          <AnalyzePipelineSection
            title="音频队列"
            pipeline={audioPipeline}
            emptyLabel="进入 audio-analysis 后，这里会显示 local health/routing、ASR queue 和活跃素材。"
          />
          <AnalyzePipelineSection
            title="细扫流水线"
            pipeline={finePipeline}
            emptyLabel="进入 fine-scan 后，这里会显示预抽、识别、就绪队列和 worker 状态。"
          />
        </div>
        <div className="pipeline-footnote">
          {progress?.detail || '当前 Analyze 已按 coarse-scan / audio-analysis / fine-scan 三段并发状态写入结构化监控。'}
        </div>
      </Card>
	      <Card className="panel">
	        <div className="section-header">
	          <h2>活跃 Analyze Job</h2>
	          <Tag>{`${analyzeJobs.length} 个`}</Tag>
	        </div>
	        <p className="muted">如果刚修改过 `/ingest-gps` 的素材 Root、FlightRecord、manual-itinerary 或时间校正，请先回到 `/ingest-gps` 运行 Ingest；Analyze 不会自动补跑导入。</p>
        <div className="stack-list">
          <div className="job-item">
            <div>
              <strong>{progress?.stepLabel || progress?.stepKey || projectProgress?.stepLabel || projectProgress?.step || '等待运行'}</strong>
              <div className="muted">{progress?.detail || projectProgress?.detail || '当前还没有项目级分析进度。'}</div>
            </div>
            <Tag>{progress?.status || projectProgress?.status || 'idle'}</Tag>
          </div>
          {progress?.fileName || projectProgress?.fileName ? (
            <div className="pipeline-footnote">
              {`当前素材：${progress?.fileName || projectProgress?.fileName}`}
            </div>
          ) : null}
	          {analyzeJobs.length === 0 ? <p className="muted">当前没有受控 analyze job。若仍有进度推进，可能是孤儿 worker。</p> : null}
	          {analyzeJobs.map(job => (
	            <div key={job.jobId} className="job-item">
	              <div>
	                <strong>{`${job.jobType} ${job.jobId.slice(0, 8)}`}</strong>
	                <div className="muted">{job.progress?.stepLabel || job.updatedAt}</div>
	              </div>
              <Tag>{job.status}</Tag>
            </div>
          ))}
        </div>
      </Card>
      </div>
    </>
  );
}

function formatAsrBackend(value) {
  if (value === 'qwen3') return 'Qwen3-ASR';
  if (value === 'whisper') return 'Whisper';
  return '尚未装载';
}

function AnalyzePipelineSection({ title, pipeline, emptyLabel }) {
  if (!pipeline) {
    return (
      <div className="job-item">
        <div>
          <strong>{title}</strong>
          <div className="muted">{emptyLabel}</div>
        </div>
        <Tag>idle</Tag>
      </div>
    );
  }

  if (pipeline.kind === 'coarse-scan') {
    return (
      <div className="pipeline-section">
        <div className="section-header">
          <h3>{title}</h3>
          <Tag>{formatCountPair(pipeline.completed, pipeline.total)}</Tag>
        </div>
        <div className="pipeline-metric-grid">
          <PipelineMetricCard label="已完成" value={formatCountPair(pipeline.completed, pipeline.total)} sub="已完成 prepared 输入落盘" />
          <PipelineMetricCard label="待处理" value={String(pipeline.pending || 0)} sub="等待进入粗扫 worker" />
          <PipelineMetricCard label="活跃 worker" value={String(pipeline.active || 0)} sub={`目标 ${pipeline.targetConcurrency || 0}`} />
          <PipelineMetricCard label="已 checkpoint" value={String(pipeline.checkpointed || 0)} sub="prepared-assets durable cache" />
        </div>
        {pipeline.activeAssetNames?.length ? <div className="muted">{`活跃素材：${pipeline.activeAssetNames.join('、')}`}</div> : null}
      </div>
    );
  }

  if (pipeline.kind === 'audio-analysis') {
    return (
      <div className="pipeline-section">
        <div className="section-header">
          <h3>{title}</h3>
          <Tag>{formatCountPair(pipeline.completed, pipeline.total)}</Tag>
        </div>
        <div className="pipeline-metric-grid">
          <PipelineMetricCard label="已完成" value={formatCountPair(pipeline.completed, pipeline.total)} sub="audio-analysis 完成或命中 checkpoint" />
          <PipelineMetricCard label="待处理" value={String(pipeline.pending || 0)} sub="尚未完成 local / ASR 队列" />
          <PipelineMetricCard label="Local worker" value={String(pipeline.activeLocal || 0)} sub={`目标 ${pipeline.targetLocalConcurrency || 0}`} />
          <PipelineMetricCard label="ASR 排队" value={String(pipeline.queuedAsr || 0)} sub="等待进入转写队列" />
          <PipelineMetricCard label="ASR worker" value={String(pipeline.activeAsr || 0)} sub={`目标 ${pipeline.targetAsrConcurrency || 0}`} />
          <PipelineMetricCard label="已 checkpoint" value={String(pipeline.checkpointed || 0)} sub="audio-checkpoints durable cache" />
        </div>
        {pipeline.activeAssetNames?.length ? <div className="muted">{`活跃素材：${pipeline.activeAssetNames.join('、')}`}</div> : null}
      </div>
    );
  }

  const checkpointSummary = [
    pipeline.checkpointPlanOrPrefetch ? `plan/prefetch ${pipeline.checkpointPlanOrPrefetch}` : null,
    pipeline.checkpointReady ? `ready ${pipeline.checkpointReady}` : null,
    pipeline.checkpointRecognizing ? `recognizing ${pipeline.checkpointRecognizing}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="pipeline-section">
      <div className="section-header">
        <h3>{title}</h3>
        <Tag>{formatCountPair(pipeline.recognized, pipeline.total)}</Tag>
      </div>
      <div className="pipeline-metric-grid">
        <PipelineMetricCard label="已预抽" value={formatCountPair(pipeline.prefetched, pipeline.total)} sub="为后续识别准备关键帧" />
        <PipelineMetricCard label="已识别" value={formatCountPair(pipeline.recognized, pipeline.total)} sub="已完成 fine-scan recognition" />
        <PipelineMetricCard label="已持久化" value={formatCountPair(pipeline.persisted, pipeline.total)} sub="已落最终 slices / report" />
        <PipelineMetricCard label="就绪队列" value={String(pipeline.ready || pipeline.checkpointReady || 0)} sub={pipeline.readyFrameBytes > 0 ? `缓存 ${formatBytes(pipeline.readyFrameBytes)}` : '等待识别消费'} />
        <PipelineMetricCard label="预抽 worker" value={String(pipeline.activePrefetch || 0)} sub={checkpointSummary || '素材级 ffmpeg prefetch'} />
        <PipelineMetricCard label="识别 worker" value={String(pipeline.activeRecognition || 0)} sub="GPU recognition worker" />
      </div>
    </div>
  );
}

function PipelineMetricCard({ label, value, sub }) {
  return (
    <div className="pipeline-metric-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

function ChronologyProgressPanel({ jobs, onRetry }) {
  const latestJob = [...(jobs || [])].sort(compareActiveProjectJobs)[0] || null;
  if (!latestJob) return null;
  const progress = latestJob.progress || null;
  const percent = resolveProgressPercent(progress);
  const extra = progress?.extra || {};
  const blockers = latestJob.blockers || [];
  const etaLabel = formatEtaSeconds(progress?.etaSeconds);
  const phaseKey = progress?.phaseKey || latestJob.jobType;
  const isChronologyBuild = phaseKey === 'chronology-build';
  const isSpanRebuild = phaseKey === 'span-rebuild';
  const captionLeft = progress
    ? `${progress.current || 0}/${progress.total || 0} ${progress.unit || 'step'}`
    : blockers.join('；') || latestJob.lastError || '等待任务写入进度';
  const chunkLabel = progress?.fileTotal ? `chunk ${progress.fileIndex || 0}/${progress.fileTotal}` : '';
  const captionRight = [chunkLabel, etaLabel ? `剩余 ${etaLabel}` : null].filter(Boolean).join(' · ')
    || latestJob.updatedAt
    || '';
  const isBlockedWithoutProgress = latestJob.status === 'blocked' && !progress;
  const isFailedWithoutProgress = latestJob.status === 'failed' && !progress;
  const isWaitingForProgress = ['queued', 'running'].includes(latestJob.status) && !progress;
  const isTerminalFailure = ['blocked', 'failed'].includes(latestJob.status);

  return (
    <div className="chronology-progress">
      <div className="chronology-progress-top">
        <div>
          <strong>{describeChronologyJobTitle(latestJob)}</strong>
          <div className="muted">{progress?.detail || progress?.stepLabel || blockers.join('；') || latestJob.lastError || latestJob.jobId}</div>
        </div>
        <div className="actions">
          <Tag color={latestJob.status === 'failed' ? 'error' : latestJob.status === 'blocked' ? 'warning' : undefined}>{latestJob.status}</Tag>
          {isTerminalFailure && onRetry ? (
            <Button type="default" size="small" onClick={() => onRetry(latestJob)}>
              {latestJob.jobType === 'span-rebuild' ? '从 checkpoint 续跑' : '重新运行'}
            </Button>
          ) : null}
        </div>
      </div>
      {progress ? (
        <div className="progress-block chronology-progress-block">
          <div className="bar-shell">
            <div className="bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-caption">
            <span>{captionLeft}</span>
            <span>{captionRight}</span>
          </div>
        </div>
      ) : null}
      {isBlockedWithoutProgress || isFailedWithoutProgress ? (
        <div className="pipeline-footnote">
          {latestJob.lastError || blockers.join('；') || '任务已失败；已完成 checkpoint 会保留供重新运行时继续使用。'}
        </div>
      ) : isWaitingForProgress ? (
        <div className="pipeline-footnote">
          任务已启动，正在等待当前阶段写入新的进度。
        </div>
      ) : (
        <div className="pipeline-metric-grid chronology-progress-metrics">
          <PipelineMetricCard label="阶段" value={progress?.stepLabel || progress?.step || latestJob.status} sub={progress?.phaseLabel || latestJob.executionMode} />
          {isChronologyBuild ? (
            <>
              <PipelineMetricCard label="Rows" value={String(extra.rowCount ?? progress?.current ?? 0)} sub={`spans ${extra.spanCount ?? 0} · spatial ${extra.spatialCount ?? 0}`} />
              <PipelineMetricCard label="事件/路线" value={String(extra.eventCount ?? 0)} sub={`route ${extra.routeEventCount ?? 0} · event ${extra.ordinaryEventCount ?? 0} · Pharos ${extra.pharosEventCount ?? 0}`} />
              <PipelineMetricCard label="时空命中" value={String(extra.directPharosCount ?? 0)} sub={`direct Pharos · continuous ${extra.continuousPharosCount ?? 0}`} />
              <PipelineMetricCard label="输入源" value={String(extra.pharosShotCount ?? 0)} sub={`Pharos shots · GPS ${extra.pharosGpsPointCount ?? extra.projectGpsPointCount ?? 0}`} />
              <PipelineMetricCard label="输入" value={extra.inputsHash ? String(extra.inputsHash).slice(0, 12) : '等待生成'} sub="chronology inputs hash" />
            </>
          ) : isSpanRebuild ? (
            <>
              <PipelineMetricCard label="素材片段" value={String(extra.spanCount ?? 0)} sub={extra.inputsHash ? `input ${String(extra.inputsHash).slice(0, 12)}` : 'span rebuild 输出'} />
              <PipelineMetricCard
                label="重试"
                value={String(extra.retryCount ?? 0)}
                sub={extra.activeFailureAttempt
                  ? `当前 ${extra.activeFailureAttempt}/${extra.activeFailureAttemptLimit ?? 3} · warnings ${extra.warningCount ?? blockers.length ?? 0}`
                  : `warnings ${extra.warningCount ?? blockers.length ?? 0}`}
              />
              <PipelineMetricCard label="失败列表" value={String(extra.failedCount ?? 0)} sub={`恢复 ${extra.recoveredFailedCount ?? 0} · 情景不明 ${extra.storyUnknownFallbackCount ?? 0}`} />
            </>
          ) : (
            <>
              <PipelineMetricCard label="状态" value={latestJob.status} sub={latestJob.executionMode} />
              <PipelineMetricCard label="warning" value={String(extra.warningCount ?? blockers.length ?? 0)} sub={blockers[0] || '当前 chronology job'} />
            </>
          )}
          <PipelineMetricCard
            label="剩余时间"
            value={etaLabel || '估算中'}
            sub={progress?.status === 'succeeded' ? '已完成' : isSpanRebuild ? '按当前 span 处理速度估算' : '按当前阶段估算'}
          />
        </div>
      )}
      {isTerminalFailure && progress ? (
        <div className="pipeline-footnote">
          {latestJob.jobType === 'span-rebuild'
            ? '已完成结果保留在 partial checkpoint；重新运行 span-rebuild 时只处理未完成项。'
            : '任务终态和最后错误已保留；可从这里重新运行。'}
        </div>
      ) : null}
    </div>
  );
}

function resolveSpansOutputUpdatedAt(spans) {
  const timestamps = [
    spans?.meta?.speechReview?.updatedAt,
    spans?.meta?.generatedAt,
    spans?.generatedAt,
    spans?.updatedAt,
  ]
    .map(value => Date.parse(value || ''))
    .filter(value => Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function isCurrentChronologyTerminalJob(job, spans) {
  if (!['blocked', 'failed'].includes(job?.status)) return false;
  if (job.jobType !== 'span-rebuild') return true;

  const spansStatus = spans?.status || spans?.meta?.status || 'missing';
  if (!['fresh', 'pending-speech-review'].includes(spansStatus)) return true;

  const spansUpdatedAt = resolveSpansOutputUpdatedAt(spans);
  const jobUpdatedAt = Date.parse(job.updatedAt || job.startedAt || '');
  if (!spansUpdatedAt) return false;
  return Number.isFinite(jobUpdatedAt) && jobUpdatedAt > spansUpdatedAt;
}

export function selectChronologyJobsForDisplay(jobs, projectId, spans) {
  const chronologyJobs = (jobs || []).filter(job =>
    job.projectId === projectId && ['spatial-refresh', 'span-rebuild', 'chronology-build'].includes(job.jobType));
  const activeJobs = chronologyJobs.filter(isLiveSupervisorJob);
  const latestByType = new Map();
  for (const job of [...chronologyJobs].sort((left, right) =>
    Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))) {
    if (!latestByType.has(job.jobType)) latestByType.set(job.jobType, job);
  }
  const terminalJobs = Array.from(latestByType.values())
    .filter(job => isCurrentChronologyTerminalJob(job, spans));
  const currentJobs = [...activeJobs, ...terminalJobs]
    .filter((job, index, items) => items.findIndex(item => item.jobId === job.jobId) === index);
  return { chronologyJobs, activeJobs, terminalJobs, currentJobs };
}

const CHRONOLOGY_JOB_GUIDANCE = {
  'span-rebuild': {
    runningTitle: '正在生成候选素材片段与模式',
    runningBody: '正在从已完成的素材分析报告重建 spans，不会重跑 ASR、视觉分析或 fine-scan。',
    runningDetail: '完成后：进入口播与字幕审查；没有口播候选时可直接生成编年史。',
    failedTitle: '候选素材片段生成未完成',
    retryLabel: '从 checkpoint 续跑',
  },
  'chronology-build': {
    runningTitle: '正在生成编年史',
    runningBody: '正在把已审查的素材片段与 GPS、Pharos 时空事实整理为事件和路线。',
    runningDetail: '完成后：先按页面指引交给 Agent 归并相邻事件，再开放人工编年史审查。',
    failedTitle: '编年史生成未完成',
    retryLabel: '重新生成编年史',
  },
  'spatial-refresh': {
    runningTitle: '正在刷新时空真相',
    runningBody: '正在把更新后的 GPS、Pharos 或素材时间写回现有分析报告的空间层。',
    runningDetail: '完成后：重新生成候选素材片段与编年史。',
    failedTitle: '时空真相刷新未完成',
    retryLabel: '重新刷新时空真相',
  },
};

export function resolveChronologyNextStep({ spans, chronology, eventConsolidation = null, activeJobs = [], terminalJobs = [] }) {
  const spansStatus = spans?.status || spans?.meta?.status || 'missing';
  const hasFreshSpans = spans?.fresh === true || (spans?.fresh == null && spansStatus === 'fresh');
  const incompletePatternCount = Number.isFinite(spans?.materialPatternIntegrity?.incompleteCount)
    ? spans.materialPatternIntegrity.incompleteCount
    : 0;
  const activeJob = [...activeJobs].sort(compareActiveProjectJobs)[0] || null;
  if (activeJob) {
    const copy = CHRONOLOGY_JOB_GUIDANCE[activeJob.jobType] || CHRONOLOGY_JOB_GUIDANCE['chronology-build'];
    return {
      key: `running-${activeJob.jobType}`,
      eyebrow: '当前阶段 · 运行中',
      title: copy.runningTitle,
      body: copy.runningBody,
      detail: copy.runningDetail,
      tone: 'accent',
      action: null,
    };
  }

  const chronologyUpdatedAt = Date.parse(chronology?.updatedAt || chronology?.generatedAt || '');
  const relevantTerminalJobs = terminalJobs.filter(job => {
    if (job.jobType !== 'chronology-build' || !Number.isFinite(chronologyUpdatedAt)) return true;
    const jobUpdatedAt = Date.parse(job.updatedAt || job.startedAt || '');
    return !Number.isFinite(jobUpdatedAt) || jobUpdatedAt > chronologyUpdatedAt;
  });
  const terminalJob = [...relevantTerminalJobs].sort(compareActiveProjectJobs)[0] || null;
  if (terminalJob) {
    const copy = CHRONOLOGY_JOB_GUIDANCE[terminalJob.jobType] || CHRONOLOGY_JOB_GUIDANCE['chronology-build'];
    return {
      key: `retry-${terminalJob.jobType}`,
      eyebrow: terminalJob.status === 'blocked' ? '下一步 · 解除阻塞' : '下一步 · 重试',
      title: copy.failedTitle,
      body: terminalJob.lastError || terminalJob.blockers?.[0] || '任务没有完成；已完成的持久化结果仍然保留。',
      detail: terminalJob.jobType === 'span-rebuild'
        ? '续跑只处理未完成项。成功后进入口播与字幕审查。'
        : copy.runningDetail,
      tone: 'error',
      action: terminalJob.jobType,
      actionLabel: copy.retryLabel,
    };
  }

  if (incompletePatternCount > 0) {
    return {
      key: 'repair-patterns',
      eyebrow: '下一步 · 修复素材模式',
      title: `原位修复 ${incompletePatternCount} 条不完整 materialPatterns`,
      body: '只重新生成异常条目的 7 项检索模式，保留现有 span、口播窗口、字幕和人工审查结果。',
      detail: '完成后：继续当前生成链路。',
      tone: 'warn',
      action: 'repair-patterns',
      actionLabel: `修复 ${incompletePatternCount} 条`,
    };
  }

  if (spansStatus === 'pending-speech-review') {
    const isHumanReview = spans?.meta?.speechReview?.phase === 'human';
    return {
      key: 'speech-review',
      eyebrow: '下一步 · 口播与字幕审查',
      title: isHumanReview ? '完成本轮口播与字幕审查' : '生成口播与字幕审查报告',
      body: isHumanReview
        ? '复核默认接受的字幕修正、口播裁切和取消建议，提交后才会把 spans 标记为 fresh。'
        : '让 Codex Agent 根据 handoff 生成统一分表报告；这一步不会重新识别音频或改变字幕时间。',
      detail: '完成后：生成编年史。',
      tone: 'warn',
      action: 'speech-review',
      actionLabel: isHumanReview ? '前往审查表' : '查看 Agent 指引',
    };
  }

  if (!hasFreshSpans) {
    return {
      key: 'span-rebuild',
      eyebrow: '下一步 · 生成素材片段',
      title: '生成候选素材片段与模式',
      body: '使用现有 assets 和 Analyze 报告生成素材片段及检索模式，不会重跑 ASR、视觉分析或 fine-scan。',
      detail: '完成后：审查口播与字幕；没有口播候选时可直接生成编年史。',
      tone: 'accent',
      action: 'span-rebuild',
      actionLabel: '生成候选素材片段与模式',
    };
  }

  if (!chronology) {
    const spanCountLabel = Number.isFinite(spans?.count) ? ` ${spans.count} 个` : '';
    return {
      key: 'chronology-build',
      eyebrow: '下一步 · 生成编年史',
      title: `用已审查的${spanCountLabel}素材片段生成编年史`,
      body: '把 fresh spans 与 GPS、Pharos 时空事实整理成事件、路线和缺口，不会重跑素材分析或字幕审查。',
      detail: '完成后：先让 Agent 归并相邻普通事件，再进行人工 Chronology V2 审查。',
      tone: 'accent',
      action: 'chronology-build',
      actionLabel: '生成编年史',
    };
  }

  if (!isChronologyEventConsolidationReady(chronology, eventConsolidation)) {
    return {
      key: 'event-consolidation',
      eyebrow: '下一步 · Agent 事件归并',
      title: `归并 ${eventConsolidation?.candidateEventCount ?? chronology.events?.length ?? 0} 个候选事件`,
      body: '复制页面指令交给 Codex Agent，让它合并相邻普通事件，或让 Pharos 锚点吸收属于同一行程的周边普通事件。允许跨零点，不会改 GPS、路线、源时间或 span。',
      detail: '完成后：开放人工编年史审查。',
      tone: 'warn',
      action: 'event-consolidation',
      actionLabel: '查看 Agent 指引',
    };
  }

  if (chronology.status !== 'confirmed') {
    return {
      key: 'review-chronology',
      eyebrow: '下一步 · 审查编年史',
      title: `审查 ${chronology.events?.length || 0} 个事件、路线和缺口`,
      body: '检查时间、地点、路线和素材归属；需要时编辑、合并、拆分或驳回，然后确认整份编年史。',
      detail: '完成后：进入 Edit Flow 规划剪辑。',
      tone: 'warn',
      action: 'review-chronology',
      actionLabel: '开始审查',
    };
  }

  return {
    key: 'edit-flow',
    eyebrow: '下一步 · Edit Flow',
    title: '编年史已确认，可以开始剪辑规划',
    body: `已确认 ${chronology.events?.length || 0} 个事件、路线和缺口；Edit Flow 将按剪辑规则选择需要执行的能力。`,
    detail: '进入 Edit Flow 后初始化或继续当前 Edit Unit。',
    tone: 'ok',
    action: 'edit-flow',
    actionLabel: '进入 Edit Flow',
  };
}

const CHRONOLOGY_STAGE_STATUS_LABELS = {
  waiting: '等待中',
  running: '执行中',
  ready: '可执行',
  review: '待审查',
  completed: '已完成',
  warning: '警告',
  failed: '失败',
};

export function resolveChronologyPipelineStages({ spans, chronology, eventConsolidation = null, activeJobs = [], terminalJobs = [] }) {
  const spansStatus = spans?.status || spans?.meta?.status || 'missing';
  const integrity = spans?.materialPatternIntegrity || {};
  const incompletePatternCount = Number.isFinite(integrity.incompleteCount)
    ? integrity.incompleteCount
    : 0;
  const completePatternCount = Number.isFinite(integrity.completeCount)
    ? integrity.completeCount
    : Math.max(0, (spans?.count || 0) - incompletePatternCount);
  const spanJob = activeJobs.find(job => job.jobType === 'span-rebuild') || null;
  const chronologyJob = activeJobs.find(job => job.jobType === 'chronology-build') || null;
  const spanFailure = terminalJobs.find(job => job.jobType === 'span-rebuild') || null;
  const chronologyUpdatedAt = Date.parse(chronology?.updatedAt || chronology?.generatedAt || '');
  const chronologyFailure = terminalJobs.find(job => {
    if (job.jobType !== 'chronology-build') return false;
    if (!Number.isFinite(chronologyUpdatedAt)) return true;
    const jobUpdatedAt = Date.parse(job.updatedAt || job.startedAt || '');
    return !Number.isFinite(jobUpdatedAt) || jobUpdatedAt > chronologyUpdatedAt;
  }) || null;
  const stageOneComplete = (spansStatus === 'fresh' || spansStatus === 'pending-speech-review')
    && (spans?.count || 0) > 0
    && incompletePatternCount === 0;
  const speechPhase = spans?.meta?.speechReview?.phase;
  const speechPending = spansStatus === 'pending-speech-review';
  const hasFreshSpans = stageOneComplete && !speechPending
    && (spans?.fresh === true || (spans?.fresh == null && spansStatus === 'fresh'));

  let spanStage;
  if (spanJob) {
    spanStage = {
      status: 'running',
      detail: spanJob.progress?.detail || '正在生成素材片段和 7 项检索模式。',
    };
  } else if (spanFailure) {
    spanStage = {
      status: 'failed',
      detail: spanFailure.lastError || spanFailure.blockers?.[0] || '任务未完成，checkpoint 已保留。',
      action: incompletePatternCount > 0 ? 'repair-patterns' : 'span-rebuild',
      actionLabel: incompletePatternCount > 0 ? `续修 ${incompletePatternCount} 条` : '从 checkpoint 续跑',
    };
  } else if (incompletePatternCount > 0) {
    spanStage = {
      status: 'warning',
      detail: `${completePatternCount}/${spans?.count || integrity.totalCount || 0} 条满足 7 项契约；${incompletePatternCount} 条需要原位修复。`,
      action: 'repair-patterns',
      actionLabel: `修复 ${incompletePatternCount} 条`,
    };
  } else if (!stageOneComplete) {
    spanStage = {
      status: 'ready',
      detail: '使用现有 Analyze 报告生成候选片段和检索模式。',
      action: 'span-rebuild',
      actionLabel: '生成素材片段与模式',
    };
  } else {
    spanStage = {
      status: 'completed',
      detail: `${spans?.count || 0} 个 span，materialPatterns 完整。`,
    };
  }

  let speechStage;
  if (!stageOneComplete) {
    speechStage = { status: 'waiting', detail: '等待素材片段与模式完成。' };
  } else if (speechPending) {
    const isHuman = speechPhase === 'human';
    speechStage = {
      status: 'review',
      detail: isHuman
        ? '报告已生成；复核默认接受的字幕修正、裁切和取消建议。'
        : '需要回到 Codex/Agent，按 handoff 生成统一审查报告。',
      action: 'speech-review',
      actionLabel: isHuman ? '打开审查表' : '查看 Agent 指引',
    };
  } else {
    speechStage = {
      status: 'completed',
      detail: spans?.meta?.speechReview?.status === 'not-required' ? '没有需要审查的口播候选。' : '口播与字幕审查已完成。',
    };
  }

  let buildStage;
  if (chronologyJob) {
    buildStage = {
      status: 'running',
      detail: chronologyJob.progress?.detail || '正在聚合事件、路线、缺口和地点。',
    };
  } else if (chronologyFailure) {
    buildStage = {
      status: 'failed',
      detail: chronologyFailure.lastError || chronologyFailure.blockers?.[0] || '编年史生成未完成。',
      action: 'chronology-build',
      actionLabel: '重新生成编年史',
    };
  } else if (chronology) {
    buildStage = { status: 'completed', detail: `已生成 ${chronology.events?.length || 0} 个事件、路线和缺口。` };
  } else if (hasFreshSpans) {
    buildStage = {
      status: 'ready',
      detail: `使用 ${spans?.count || 0} 个已审查 span 构建 Chronology V2。`,
      action: 'chronology-build',
      actionLabel: '生成编年史',
    };
  } else {
    buildStage = { status: 'waiting', detail: '等待口播与字幕审查完成。' };
  }

  const consolidationReady = isChronologyEventConsolidationReady(chronology, eventConsolidation);
  let consolidationStage;
  if (!chronology) {
    consolidationStage = { status: 'waiting', detail: '等待确定性编年史候选生成。' };
  } else if (consolidationReady) {
    const mergedCount = eventConsolidation?.mergeGroupCount || 0;
    consolidationStage = {
      status: 'completed',
      detail: eventConsolidation?.status === 'not-required'
        ? '没有需要 Agent 归并的相邻普通事件。'
        : `Agent 归并已完成${mergedCount ? `，合并 ${mergedCount} 组事件` : '，本轮无需合并'}。`,
    };
  } else {
    consolidationStage = {
      status: 'review',
      detail: '复制 handoff 指令交给 Codex Agent；完成前人工编年史审查保持锁定。',
      action: 'event-consolidation',
      actionLabel: '查看 Agent 指引',
    };
  }

  const reviewStage = chronology && consolidationReady
    ? chronology.status === 'confirmed'
      ? { status: 'completed', detail: `${chronology.events?.length || 0} 个事件、路线和缺口已确认。` }
      : {
          status: 'review',
          detail: '检查时间、地点、路线和素材归属，然后确认整份编年史。',
          action: 'review-chronology',
          actionLabel: '开始审查',
        }
    : { status: 'waiting', detail: chronology ? '等待 Agent 事件归并完成。' : '等待 Chronology V2 生成。' };
  const editStage = chronology?.status === 'confirmed'
    ? {
        status: 'ready',
        detail: '编年史已确认，可以进入剪辑规则驱动的能力流。',
        action: 'edit-flow',
        actionLabel: '进入 Edit Flow',
      }
    : { status: 'waiting', detail: '等待编年史确认。' };

  const stages = [
    { key: 'spans', title: '素材片段与模式', ...spanStage },
    { key: 'speech-review', title: '口播与字幕审查', ...speechStage },
    { key: 'chronology-build', title: '编年史生成', ...buildStage },
    { key: 'event-consolidation', title: 'Agent 事件归并', ...consolidationStage },
    { key: 'chronology-review', title: '编年史审查', ...reviewStage },
    { key: 'edit-flow', title: 'Edit Flow', ...editStage },
  ];
  const currentIndex = stages.findIndex(stage => stage.status !== 'completed' && stage.status !== 'waiting');
  return stages.map((stage, index) => ({
    ...stage,
    index: index + 1,
    statusLabel: CHRONOLOGY_STAGE_STATUS_LABELS[stage.status] || stage.status,
    current: index === currentIndex,
  }));
}

export function isChronologyEventConsolidationReady(chronology, eventConsolidation) {
  if (!chronology) return false;
  if (chronology.status === 'confirmed') return true;
  return Boolean(eventConsolidation
    && eventConsolidation.inputsHash === chronology.inputsHash
    && ['completed', 'not-required'].includes(eventConsolidation.status));
}

function ChronologyPage({
  projectId,
  config,
  pharosContext,
  spans,
  reviews,
  setReviews,
  resolveReview,
  capabilities,
  jobs,
  busy,
  onSaveSpeechReviewDraft,
  onCommitSpeechReview,
  onRunSpatialRefresh,
  onRunSpanRebuild,
  onRunChronologyBuild,
  onConfirm,
  onSaveEvent,
  onMergeEvents,
  onSplitEvent,
}) {
  const navigate = useNavigate();
  const chronology = config?.chronology || null;
  const eventConsolidation = config?.eventConsolidation || null;
  const events = chronology?.events || [];
  const spansStatus = spans?.status || spans?.meta?.status || 'missing';
  const isPendingSpeechReview = spansStatus === 'pending-speech-review';
  const chronologyJobState = selectChronologyJobsForDisplay(jobs, projectId, spans);
  const activeChronologyJobs = chronologyJobState.activeJobs;
  const terminalChronologyJobs = chronologyJobState.terminalJobs;
  const blockedChronologyJobs = terminalChronologyJobs.filter(job => job.status === 'blocked');
  const failedChronologyJobs = terminalChronologyJobs.filter(job => job.status === 'failed');
  const currentChronologyJobs = chronologyJobState.currentJobs;
  const spatialRefreshJobs = activeChronologyJobs.filter(job => job.jobType === 'spatial-refresh');
  const spanRebuildJobs = activeChronologyJobs.filter(job => job.jobType === 'span-rebuild');
  const chronologyBuildJobs = activeChronologyJobs.filter(job => job.jobType === 'chronology-build');
  const spatialRefreshCapability = capabilities?.jobs?.find(job => job.jobType === 'spatial-refresh');
  const spanRebuildCapability = capabilities?.jobs?.find(job => job.jobType === 'span-rebuild');
  const chronologyBuildCapability = capabilities?.jobs?.find(job => job.jobType === 'chronology-build');
  const canStartSpatialRefresh = Boolean(projectId)
    && !busy['job:spatial-refresh']
    && activeChronologyJobs.length === 0
    && spatialRefreshCapability?.supported !== false;
  const canStartSpanRebuild = Boolean(projectId)
    && !busy['job:span-rebuild']
    && activeChronologyJobs.length === 0
    && spanRebuildCapability?.supported !== false;
  const speechReview = spans?.meta?.speechReview || {};
  const speechTranscriptReview = spans?.speechTranscriptReview || null;
  const isHumanTranscriptReview = speechReview.phase === 'human';
  const speechWindowAgentHandoffPath = speechReview.handoffPath || null;
  const speechReviewHandoffRef = speechWindowAgentHandoffPath
    || `projects/${projectId || '<projectId>'}/.tmp/chronology/speech-window-agent-handoff.md`;
  const speechReviewAgentPrompt = `请按 kairos-speech-review skill 和 handoff 生成这个项目的口播与字幕审查报告：读取 ${speechReviewHandoffRef}${speechReview.reviewArtifactPath ? ` 和 ${speechReview.reviewArtifactPath}` : ''}，调用 stageProjectSpeechTranscriptReview 写统一 JSON 和分表报告。简体中文正字归一直接应用；其余建议默认接受但不要在用户提交前写入正式 spans。不要重跑 ASR、span-builder、fine-scan 或 chronology。`;
  const eventConsolidationHandoffRef = eventConsolidation?.handoffPath
    || `projects/${projectId || '<projectId>'}/.tmp/chronology/event-consolidation-agent-handoff.md`;
  const eventConsolidationAgentPrompt = `请按 kairos-chronology-consolidation skill 处理项目 ${projectId || '<projectId>'}：读取 ${eventConsolidationHandoffRef} 和当前 media/chronology.json。合并语义连续的相邻普通 pending event；也允许用 anchorEventId 指定组内唯一 confirmed Pharos event，让其吸收两侧属于同一行程的相邻普通 pending event，并保留 Pharos id、标题、地点和 confirmed 状态。允许跨自然日零点，不得跨 route、gap 或另一个 Pharos event，也不得修改 GPS、路线、源时间和 span。按 handoff 写 decisions 并运行其中的应用命令；不要重跑 chronology-build、Analyze 或 span-rebuild。`;
  const hasFreshSpans = spans?.fresh === true || (spans?.fresh == null && spansStatus === 'fresh');
  const chronologyReviewUnlocked = isChronologyEventConsolidationReady(chronology, eventConsolidation);
  const canStartChronologyBuild = Boolean(projectId)
    && hasFreshSpans
    && !busy['job:chronology-build']
    && activeChronologyJobs.length === 0
    && chronologyBuildCapability?.supported !== false;
  const pipelineStages = resolveChronologyPipelineStages({
    spans,
    chronology,
    eventConsolidation,
    activeJobs: activeChronologyJobs,
    terminalJobs: terminalChronologyJobs,
  });
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dayFilter, setDayFilter] = useState('all');
  const [queryFilter, setQueryFilter] = useState('');
  const [selected, setSelected] = useState({});
  const [drafts, setDrafts] = useState({});
  const [activeEventId, setActiveEventId] = useState('');
  const chronologyTimeZone = useMemo(() => resolveChronologyTimeZone(pharosContext), [pharosContext]);

  useEffect(() => {
    setSelected({});
    setDrafts({});
    setActiveEventId('');
  }, [chronology?.inputsHash, chronology?.updatedAt]);

  const days = useMemo(() => dedupeUiStrings(events
    .map(event => resolveChronologyDay(event, chronologyTimeZone))
    .filter(Boolean)), [events, chronologyTimeZone]);
  const filteredEvents = filterChronologyEvents(
    events,
    { kind: kindFilter, status: statusFilter, day: dayFilter, query: queryFilter },
    event => resolveChronologyDay(event, chronologyTimeZone),
  );
  const selectedEventIds = Object.entries(selected)
    .filter(([, value]) => Boolean(value))
    .map(([eventId]) => eventId)
    .filter(eventId => events.some(event => event.id === eventId));

  function updateDraft(event, patch) {
    setDrafts(current => ({
      ...current,
      [event.id]: {
        ...(current[event.id] || event),
        ...patch,
      },
    }));
  }

  function saveDraft(event) {
    const draft = drafts[event.id] || event;
    onSaveEvent(event.id, buildChronologyEventPayload(draft));
  }

  function retryChronologyJob(job) {
    if (job?.jobType === 'span-rebuild') return onRunSpanRebuild();
    if (job?.jobType === 'chronology-build') return onRunChronologyBuild();
    if (job?.jobType === 'spatial-refresh') return onRunSpatialRefresh();
    return undefined;
  }

  function runChronologyStageAction(action) {
    if (action === 'span-rebuild') return onRunSpanRebuild();
    if (action === 'repair-patterns') return onRunSpanRebuild({ mode: 'repair-patterns' });
    if (action === 'chronology-build') return onRunChronologyBuild();
    if (action === 'spatial-refresh') return onRunSpatialRefresh();
    if (action === 'speech-review') {
      document.getElementById('chronology-speech-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return undefined;
    }
    if (action === 'event-consolidation') {
      document.getElementById('chronology-event-consolidation')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return undefined;
    }
    if (action === 'review-chronology') {
      document.getElementById('chronology-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return undefined;
    }
    if (action === 'edit-flow') return navigate('/edit');
    return undefined;
  }

  function isChronologyStageActionDisabled(action) {
    if (action === 'span-rebuild' || action === 'repair-patterns') return !canStartSpanRebuild;
    if (action === 'chronology-build') return !canStartChronologyBuild;
    if (action === 'spatial-refresh') return !canStartSpatialRefresh;
    return false;
  }

  const activeEvent = events.find(event => event.id === activeEventId) || null;
  const activeDraft = activeEvent ? drafts[activeEvent.id] || activeEvent : null;
  const chronologyColumns = [
    {
      title: '时间',
      key: 'time',
      width: 190,
      render: (_, event) => (
        <div className="chronology-cell-stack">
          <strong>{formatChronologyTimeRange(event, chronologyTimeZone)}</strong>
          <span>{resolveChronologyDay(event, chronologyTimeZone)}</span>
        </div>
      ),
    },
    { title: '类型', dataIndex: 'kind', width: 92, render: value => <Tag>{value}</Tag> },
    {
      title: '事件',
      key: 'event',
      width: 360,
      render: (_, event) => (
        <div className="chronology-event-cell">
          <strong>{event.title || '未命名事件'}</strong>
          <span>{event.summary || '暂无摘要'}</span>
        </div>
      ),
    },
    {
      title: '地点 / 路线',
      key: 'location',
      width: 260,
      render: (_, event) => event.kind === 'route'
        ? `${event.route?.from || '未定'} → ${event.route?.to || '未定'}`
        : event.location || '未定',
    },
    { title: '素材', key: 'spans', width: 92, align: 'right', render: (_, event) => `${event.spanIds?.length || 0} spans` },
    { title: '状态', dataIndex: 'reviewStatus', width: 112, render: value => <Tag color={value === 'confirmed' ? 'success' : value === 'rejected' ? 'error' : 'warning'}>{value}</Tag> },
    {
      title: '',
      key: 'actions',
      width: 90,
      fixed: 'right',
      render: (_, event) => <Button type="default" size="small" disabled={!chronologyReviewUnlocked} onClick={clickEvent => { clickEvent.stopPropagation(); setActiveEventId(event.id); }}>编辑</Button>,
    },
  ];

  return (
    <div className="route-page">
      <RouteIntro
        title="编年史"
        subtitle="审查项目级 Chronology V2：事件、路线、缺口、时间地点、确认状态和关联 span。"
      />
      <Card className="panel">
        <div className="section-header">
          <h2>生成链路</h2>
          <Tag color={(spans?.materialPatternIntegrity?.incompleteCount || 0) > 0 ? 'warning' : undefined}>
            {(spans?.materialPatternIntegrity?.incompleteCount || 0) > 0
              ? `materialPatterns 缺失 · ${spans.materialPatternIntegrity.incompleteCount}`
              : `spans ${spans?.status || 'missing'} · ${spans?.count || 0}`}
          </Tag>
        </div>
        <div className="chronology-stage-rail" aria-label="Chronology 生成链路">
          {pipelineStages.map(stage => (
            <section
              key={stage.key}
              className={`chronology-stage-card is-${stage.status}${stage.current ? ' is-current' : ''}`}
              aria-current={stage.current ? 'step' : undefined}
            >
              <div className="chronology-stage-card-head">
                <span className="chronology-stage-index">{stage.index}</span>
                <span className={`chronology-stage-status is-${stage.status}`}>{stage.statusLabel}</span>
              </div>
              <h3>{stage.title}</h3>
              <p>{stage.detail}</p>
              {stage.action ? (
                <Button
                  type={stage.current ? 'primary' : 'default'}
                  disabled={isChronologyStageActionDisabled(stage.action)}
                  onClick={() => runChronologyStageAction(stage.action)}
                >
                  {stage.actionLabel}
                </Button>
              ) : null}
            </section>
          ))}
        </div>
        <ChronologyProgressPanel jobs={currentChronologyJobs} onRetry={retryChronologyJob} />
        <div id="chronology-speech-review">
          {isPendingSpeechReview ? (
            <WorkflowPrompt
              eyebrow={isHumanTranscriptReview ? 'Human Review Pending' : 'Agent Review Pending'}
              title={isHumanTranscriptReview ? '审查口播与字幕建议后再生成编年史' : '等待 Agent 生成口播与字幕审查报告'}
              body={isHumanTranscriptReview
                ? `建议修正、裁切和取消默认接受；手动取消不采用的项目，并处理 ${speechReview.needsListeningCount ?? 0} 条需人工听音项后统一提交。`
                : `当前有 ${speechReview.candidateCount ?? 0} 个 speech/mixed candidates。Agent 将生成分表报告，不会直接应用裁切、取消或非正字归一的文字修改。`}
              detail={!isHumanTranscriptReview ? (
                <div className="workflow-prompt-command-block">
                  <div className="workflow-prompt-command-label">回到 Codex/Agent 后复制这句：</div>
                  <pre className="workflow-prompt-command">{speechReviewAgentPrompt}</pre>
                  {speechWindowAgentHandoffPath ? <div>{`Handoff: ${speechWindowAgentHandoffPath}`}</div> : null}
                  {speechReview.reviewArtifactPath ? <div>{`Audit: ${speechReview.reviewArtifactPath}`}</div> : null}
                  {speechReview.reportPath ? <div>{`Report: ${speechReview.reportPath}`}</div> : null}
                </div>
              ) : null}
              actions={!isHumanTranscriptReview ? (
                <Button
                  type="default"
                  onClick={() => window.navigator?.clipboard?.writeText?.(speechReviewAgentPrompt)?.catch?.(() => undefined)}
                >
                  复制 Agent 指令
                </Button>
              ) : null}
              tone="warn"
            />
          ) : null}
          {isHumanTranscriptReview ? (
            <SpeechTranscriptReviewPanel
              projectId={projectId}
              review={speechTranscriptReview}
              busy={busy['chronology:speech-transcript-review']}
              onSaveDraft={onSaveSpeechReviewDraft}
              onSubmit={onCommitSpeechReview}
            />
          ) : null}
        </div>
        <div id="chronology-event-consolidation">
          {chronology && !chronologyReviewUnlocked ? (
            <WorkflowPrompt
              eyebrow="Agent Review Pending"
              title="先完成事件语义归并，再进行人工编年史审查"
              body={`当前确定性候选包含 ${eventConsolidation?.candidateEventCount ?? events.length} 个普通待审事件。Agent 可合并相邻普通事件，也可让 Pharos 锚点吸收同一行程的周边事件；允许跨零点，不改 GPS、路线、源时间或素材。`}
              detail={(
                <div className="workflow-prompt-command-block">
                  <div className="workflow-prompt-command-label">复制到 Codex Agent：</div>
                  <pre className="workflow-prompt-command">{eventConsolidationAgentPrompt}</pre>
                  <div>{`Handoff: ${eventConsolidationHandoffRef}`}</div>
                  {eventConsolidation?.decisionsPath ? <div>{`Decisions: ${eventConsolidation.decisionsPath}`}</div> : null}
                </div>
              )}
              actions={(
                <Button
                  type="primary"
                  onClick={() => window.navigator?.clipboard?.writeText?.(eventConsolidationAgentPrompt)?.catch?.(() => undefined)}
                >
                  复制 Agent 指令
                </Button>
              )}
              tone="warn"
            />
          ) : null}
        </div>
        <details className="compact-disclosure chronology-maintenance-disclosure">
          <summary>
            <span>
              <strong>维护与诊断</strong>
              <small>仅在分析报告、GPS、Pharos 或素材时间发生变化时使用</small>
            </span>
            <Tag>{`${activeChronologyJobs.length ? `${activeChronologyJobs.length} 运行中` : '当前无任务'}${spans?.meta?.warnings?.length ? ` · ${spans.meta.warnings.length} 条历史警告` : ''}`}</Tag>
          </summary>
          <div className="chronology-maintenance-body">
            <div className="chronology-maintenance-actions">
              <div>
                <Button type="default" disabled={!canStartSpanRebuild} onClick={() => onRunSpanRebuild()}>
                  {busy['job:span-rebuild'] || spanRebuildJobs.length > 0 ? '生成中…' : '生成候选素材片段与模式'}
                </Button>
                <span>Analyze 报告或 span 派生策略变化后使用</span>
              </div>
              <div>
                <Button type="default" disabled={!canStartChronologyBuild} onClick={onRunChronologyBuild}>
                  {busy['job:chronology-build'] || chronologyBuildJobs.length > 0 ? '刷新中…' : '生成/刷新编年史'}
                </Button>
                <span>fresh spans 或编年史输入变化后使用</span>
              </div>
              <div>
                <Button type="default" disabled={!canStartSpatialRefresh} onClick={onRunSpatialRefresh}>
                  {busy['job:spatial-refresh'] || spatialRefreshJobs.length > 0 ? '刷新中…' : '刷新时空真相'}
                </Button>
                <span>GPS、Pharos 或素材时间变化后使用</span>
              </div>
            </div>
            <div className="monitor-toolbar-meta chronology-diagnostic-meta">
              <span>{activeChronologyJobs.length > 0
                ? `${activeChronologyJobs.length} 个任务运行中`
                : failedChronologyJobs.length > 0
                  ? `${failedChronologyJobs.length} 个任务失败`
                  : blockedChronologyJobs.length > 0
                    ? `${blockedChronologyJobs.length} 个任务已阻塞`
                    : '当前无 chronology 任务'}</span>
              {spans?.meta?.inputsHash ? <span>{`spans input ${spans.meta.inputsHash.slice(0, 12)}`}</span> : null}
            </div>
            {spans?.meta?.warnings?.length ? (
              <div className="chronology-warning-list">
                <strong>历史 spans 警告</strong>
                <ul>
                  {spans.meta.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      </Card>
      <Card id="chronology-review" className="panel">
        <div className="section-header">
          <h2>Chronology V2</h2>
          <Tag>{chronology ? `${chronology.status} · ${events.length} events` : 'missing'}</Tag>
          <Tag>{chronologyTimeZone}</Tag>
        </div>
        <div className="chronology-toolbar">
          <div className="monitor-toolbar-group">
            <input
              className="chronology-search"
              value={queryFilter}
              onChange={event => setQueryFilter(event.target.value)}
              placeholder="搜索标题、地点或摘要"
            />
            <ChronologySelect
              value={dayFilter}
              onChange={setDayFilter}
              options={[{ value: 'all', label: '全部日期' }, ...days.map(day => ({ value: day, label: day }))]}
            />
            <ChronologySelect
              value={kindFilter}
              onChange={setKindFilter}
              options={[
                { value: 'all', label: '全部类型' },
                { value: 'event', label: 'event' },
                { value: 'route', label: 'route' },
                { value: 'gap', label: 'gap' },
              ]}
            />
            <ChronologySelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'pending', label: 'pending' },
                { value: 'confirmed', label: 'confirmed' },
                { value: 'rejected', label: 'rejected' },
              ]}
            />
          </div>
          <div className="actions">
            <Button
              type={selectedEventIds.length >= 2 && !busy['chronology:merge'] ? 'default' : 'disabled'}
              disabled={!chronologyReviewUnlocked || selectedEventIds.length < 2 || busy['chronology:merge']}
              onClick={() => onMergeEvents(selectedEventIds)}
            >
              合并
            </Button>
            <Button
              type={chronology && !busy['chronology:confirm'] ? 'primary' : 'disabled'}
              disabled={!chronology || !chronologyReviewUnlocked || busy['chronology:confirm']}
              onClick={onConfirm}
            >
              {busy['chronology:confirm'] ? '确认中…' : '确认全部'}
            </Button>
          </div>
        </div>
        <div className="pipeline-footnote">
          {chronology
            ? `schema ${chronology.schemaVersion} · inputs ${chronology.inputsHash?.slice(0, 12) || 'unknown'} · asset anchors ${chronology.assetIndex?.length || 0}`
            : '尚未生成 Chronology V2。'}
        </div>
      </Card>
      <Card className="panel chronology-table-panel">
        <Table
          virtual
          rowKey="id"
          size="small"
          pagination={false}
          columns={chronologyColumns}
          dataSource={filteredEvents}
          scroll={{ x: 1200, y: 520 }}
          locale={{ emptyText: '当前过滤条件下没有 chronology event。' }}
          rowSelection={chronologyReviewUnlocked ? {
            selectedRowKeys: selectedEventIds,
            onChange: keys => setSelected(Object.fromEntries(keys.map(key => [String(key), true]))),
          } : undefined}
          onRow={event => chronologyReviewUnlocked ? ({ onClick: () => setActiveEventId(event.id) }) : ({})}
        />
      </Card>
      <Drawer
        title={activeDraft?.title || '编辑 Chronology 事件'}
        width={520}
        open={Boolean(activeDraft)}
        onClose={() => setActiveEventId('')}
        extra={activeDraft ? <Tag>{activeDraft.id}</Tag> : null}
      >
        {activeEvent && activeDraft ? (
          <div className="chronology-drawer-form">
            <div className="field-grid">
              <ChronologySelect value={activeDraft.kind} onChange={value => updateDraft(activeEvent, { kind: value })} options={[{ value: 'event', label: 'event' }, { value: 'route', label: 'route' }, { value: 'gap', label: 'gap' }]} />
              <ChronologySelect value={activeDraft.reviewStatus} onChange={value => updateDraft(activeEvent, { reviewStatus: value })} options={[{ value: 'pending', label: 'pending' }, { value: 'confirmed', label: 'confirmed' }, { value: 'rejected', label: 'rejected' }]} />
            </div>
            <label><span>标题</span><input value={activeDraft.title || ''} onChange={event => updateDraft(activeEvent, { title: event.target.value })} /></label>
            <label><span>摘要</span><textarea rows={5} value={activeDraft.summary || ''} onChange={event => updateDraft(activeEvent, { summary: event.target.value })} /></label>
            <div className="field-grid">
              <label><span>开始时间</span><input value={activeDraft.startAt || ''} onChange={event => updateDraft(activeEvent, { startAt: event.target.value })} /></label>
              <label><span>结束时间</span><input value={activeDraft.endAt || ''} onChange={event => updateDraft(activeEvent, { endAt: event.target.value })} /></label>
            </div>
            <label><span>地点</span><input value={activeDraft.location || ''} onChange={event => updateDraft(activeEvent, { location: event.target.value })} /></label>
            <div className="field-grid">
              <label><span>路线起点</span><input value={activeDraft.route?.from || ''} onChange={event => updateDraft(activeEvent, { route: { ...(activeDraft.route || {}), from: event.target.value } })} /></label>
              <label><span>路线终点</span><input value={activeDraft.route?.to || ''} onChange={event => updateDraft(activeEvent, { route: { ...(activeDraft.route || {}), to: event.target.value } })} /></label>
            </div>
            <div className="chronology-drawer-meta">{`${activeDraft.spanIds?.length || 0} spans · ${formatChronologyTimeRange(activeDraft, chronologyTimeZone)}`}</div>
            <div className="actions chronology-drawer-actions">
              <Button type="default" disabled={busy[`chronology:event:${activeEvent.id}`]} onClick={() => saveDraft(activeEvent)}>保存</Button>
              <Button type="primary" disabled={busy[`chronology:event:${activeEvent.id}`]} onClick={() => onSaveEvent(activeEvent.id, { reviewStatus: 'confirmed' })}>确认</Button>
              <Button type="error" disabled={busy[`chronology:event:${activeEvent.id}`]} onClick={() => onSaveEvent(activeEvent.id, { reviewStatus: 'rejected' })}>驳回</Button>
              <Button type="warning" disabled={(activeEvent.spanIds?.length || 0) <= 1 || busy[`chronology:split:${activeEvent.id}`]} onClick={() => onSplitEvent(activeEvent.id)}>拆分</Button>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function resolveChronologyDay(event, timeZone) {
  const value = event.startAt || event.endAt || '';
  return formatChronologyDate(value, timeZone);
}

function formatChronologyTimeRange(event, timeZone) {
  const start = formatChronologyTime(event.startAt, timeZone);
  const end = formatChronologyTime(event.endAt, timeZone);
  if (start && end && start !== end) return `${start} - ${end}`;
  return start || end || '未定时间';
}

function formatChronologyTime(value, timeZone) {
  if (!value) return '';
  const parts = getChronologyDateTimeParts(value, timeZone);
  if (!parts) return value.replace('T', ' ').replace('.000Z', 'Z').slice(0, 19);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatChronologyDate(value, timeZone) {
  const parts = getChronologyDateTimeParts(value, timeZone);
  if (!parts) return value.slice(0, 10);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getChronologyDateTimeParts(value, timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || getBrowserTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    });
    const parts = new Map(formatter.formatToParts(date).map(part => [part.type, part.value]));
    if (!parts.get('year') || !parts.get('month') || !parts.get('day') || !parts.get('hour') || !parts.get('minute') || !parts.get('second')) {
      return null;
    }
    return {
      year: parts.get('year'),
      month: parts.get('month'),
      day: parts.get('day'),
      hour: parts.get('hour'),
      minute: parts.get('minute'),
      second: parts.get('second'),
    };
  } catch {
    return null;
  }
}

function resolveChronologyTimeZone(pharosContext) {
  const timezones = dedupeUiStrings((pharosContext?.trips || [])
    .map(trip => trip?.timezone)
    .filter(isValidUiTimeZone));
  return timezones[0] || getBrowserTimeZone();
}

function getBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidUiTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function dedupeUiStrings(values) {
  return Array.from(new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0)));
}

function ChronologySelect({ value, onChange, options }) {
  return (
    <Select
      className="chronology-select"
      value={value}
      onChange={onChange}
      autoUpdown
      maxHeight={260}
      size="small"
    >
      {options.map(option => (
        <Option key={option.value} value={option.value} label={option.label} />
      ))}
    </Select>
  );
}

function StylePage({ config, capabilities, jobs, setStyleSources, onSave, busy, onRun, location, history }) {
  if (!config) {
    return (
      <div className="route-page">
        <EmptyPanel label="风格来源配置尚未加载完成。" />
      </div>
    );
  }
  const requestedCategoryId = resolveCurrentStyleCategory(config, location.search, jobs);
  const styleCapability = capabilities?.jobs?.find(job => job.jobType === 'style-analysis');
  const activeStyleJobs = (jobs || []).filter(job =>
    job.jobType === 'style-analysis'
      && ['queued', 'running', 'blocked'].includes(job.status),
  );
  return (
    <MonitorLoader
      kind="style"
      categoryId={requestedCategoryId}
      emptyLabel="当前分类还没有可展示的风格分析监控数据。"
      toolbar={model => {
        const resolvedCategoryId = getStyleMonitorCategoryId(model)
          || requestedCategoryId
          || config.defaultCategory
          || config.categories[0]?.categoryId
          || '';
        const canStartStyleAnalysis = Boolean(resolvedCategoryId)
          && !busy['job:style-analysis']
          && activeStyleJobs.length === 0
          && styleCapability?.supported !== false;
        return (
          <>
          <div className="monitor-toolbar-group">
            <select
              value={resolvedCategoryId}
              onChange={event => history.push(buildStylePath(event.target.value))}
            >
              {config.categories.map(category => (
                <option key={category.categoryId} value={category.categoryId}>{category.displayName}</option>
              ))}
            </select>
            <Button
              type={canStartStyleAnalysis ? 'primary' : 'disabled'}
              disabled={!canStartStyleAnalysis}
              onClick={() => onRun(resolvedCategoryId)}
            >
              {busy['job:style-analysis'] ? '启动中…' : activeStyleJobs.length > 0 ? '风格分析运行中…' : '分析当前风格'}
            </Button>
          </div>
          <div className="monitor-toolbar-meta">
            <span>{`${config.categories.length} 个风格档案`}</span>
            {resolvedCategoryId ? <span>{resolvedCategoryId}</span> : null}
          </div>
          </>
        );
      }}
      afterMonitor={(
        <StyleSourcesEditor
          config={config}
          setConfig={setStyleSources}
          onSave={onSave}
          busy={busy['style-sources']}
        />
      )}
    />
  );
}

function EditFlowPage({
  config,
  activeEditId,
  editFlowPlan,
  editFlowRuns,
  capabilities,
  editRules,
  styleSources,
  busy,
  onSaveEditUnit,
  onSaveResolveSnapshot,
  onRegisterResolveSnapshot,
  onInstallResolveAssets,
  onRelinkResolveMedia,
  editResolveAssetsResult,
  editResolveAssetsError,
  editRelinkResult,
  editRelinkError,
}) {
  const editUnit = config?.editUnit;
  const inferredSelections = resolveEditFlowSelections({
    activeEditId,
    editFlowPlan,
    editRules,
    editUnit,
    styleSources,
  });
  const [editId, setEditId] = useState(inferredSelections.editId);
  const [editRuleCategory, setEditRuleCategory] = useState(inferredSelections.editRuleCategory);
  const [styleCategory, setStyleCategory] = useState(inferredSelections.styleCategory);
  const [externalDrpPath, setExternalDrpPath] = useState('');
  const [expandedStepIds, setExpandedStepIds] = useState({});

  useEffect(() => {
    setEditRuleCategory(inferredSelections.editRuleCategory);
  }, [editUnit?.updatedAt, inferredSelections.editRuleCategory]);

  useEffect(() => {
    setStyleCategory(inferredSelections.styleCategory);
  }, [editUnit?.updatedAt, inferredSelections.styleCategory]);

  useEffect(() => {
    const nextEditId = editUnit?.editId || activeEditId || editFlowPlan?.editId;
    if (nextEditId && nextEditId !== editId) setEditId(nextEditId);
  }, [activeEditId, editFlowPlan?.editId, editId, editUnit?.editId]);

  const registry = useMemo(() => {
    const map = new Map();
    (capabilities?.editFlowCapabilities || []).forEach(capability => {
      map.set(capability.capabilityId, capability);
    });
    return map;
  }, [capabilities]);
  const latestRunByStep = useMemo(() => {
    const map = new Map();
    (editFlowRuns || []).forEach(run => {
      const previous = map.get(run.stepId);
      if (!previous || String(run.startedAt || '').localeCompare(String(previous.startedAt || '')) > 0) {
        map.set(run.stepId, run);
      }
    });
    return map;
  }, [editFlowRuns]);
  const firstActionableStepId = useMemo(() => (
    (editFlowPlan?.steps || []).find(step => latestRunByStep.get(step.id)?.status !== 'completed')?.id || ''
  ), [editFlowPlan?.steps, latestRunByStep]);

  const planStatus = editFlowPlan?.status || 'missing';
  const isBusy = Boolean(busy['edit-unit']);
  const saveResolveBusy = Boolean(busy['edit:resolve-snapshot']);
  const registerResolveBusy = Boolean(busy['edit:resolve-register']);
  const installResolveAssetsBusy = Boolean(busy['edit:resolve-assets']);
  const relinkResolveBusy = Boolean(busy['edit:resolve-relink']);
  const editRelinkSummary = editRelinkResult?.hostSummary || null;
  const resolveAssetsSummary = editResolveAssetsResult || editRelinkSummary?.resolveAssetsInstall || config?.resolveAssets || null;
  const resolveAssetsWarningText = formatResolveAssetsWarning(resolveAssetsSummary);
  const editRelinkWarningText = formatEditRelinkWarnings(editRelinkSummary);
  const spansReady = config?.spans?.fresh;
  const chronologyReady = config?.chronology?.chronology?.status === 'confirmed';
  const editUnitSaved = Boolean(editUnit?.editRuleCategory);
  const canSaveEditUnit = Boolean(editId?.trim() && editRuleCategory);
  const editResolveProject = config?.editResolveProject || null;
  const latestEditDrp = editResolveProject?.latestDrpSnapshot || null;

  return (
    <div className="route-page edit-flow-page">
      <RouteIntro
        title="剪辑流"
        subtitle="初始化 Edit Unit，绑定剪辑规则与风格档案；Flow Plan 和后续产物由 Codex Agent 在仓库内生成维护。"
      />

      <div className="edit-flow-dashboard">
        <Card className="panel edit-flow-control-panel">
          <div className="edit-flow-panel-head">
            <div>
              <h2>Edit 初始化</h2>
              <p>这里只保存 editId、剪辑规则和风格档案；后续剪辑产物由 Codex Agent 维护。</p>
            </div>
            <Button
              type={isBusy || !canSaveEditUnit ? 'disabled' : 'primary'}
              disabled={isBusy || !canSaveEditUnit}
              onClick={() => onSaveEditUnit({
                editId,
                editRuleCategory,
                styleCategory,
              })}
            >
              {isBusy ? '保存中…' : '保存 Edit 初始化'}
            </Button>
          </div>

          <div className="edit-flow-form-grid">
            <label className="edit-flow-field">
              <span>Edit ID</span>
              <input value={editId} onChange={event => setEditId(event.target.value)} />
            </label>
            <label className="edit-flow-field">
              <span>剪辑规则</span>
              <select value={editRuleCategory} onChange={event => setEditRuleCategory(event.target.value)}>
                <option value="">请选择</option>
                {(editRules?.categories || []).map(category => (
                  <option key={category.categoryId} value={category.categoryId}>
                    {category.displayName || category.categoryId}
                  </option>
                ))}
              </select>
            </label>
            <label className="edit-flow-field">
              <span>风格档案</span>
              <select value={styleCategory} onChange={event => setStyleCategory(event.target.value)}>
                <option value="">不使用</option>
                {(styleSources?.categories || []).map(category => (
                  <option key={category.categoryId} value={category.categoryId}>
                    {category.displayName || category.categoryId}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="edit-flow-status-strip">
            <EditFlowStatusItem label="Edit Unit" value={editUnitSaved ? 'saved' : 'unsaved'} tone={editUnitSaved ? 'good' : 'warn'} />
            <EditFlowStatusItem label="Spans" value={spansReady ? 'fresh' : 'missing/stale'} tone={spansReady ? 'good' : 'warn'} />
            <EditFlowStatusItem label="Chronology" value={chronologyReady ? 'confirmed' : 'not ready'} tone={chronologyReady ? 'good' : 'warn'} />
            <EditFlowStatusItem label="Flow Plan" value={planStatus} tone={planStatus === 'confirmed' ? 'good' : planStatus === 'stale' ? 'bad' : 'warn'} />
            <EditFlowStatusItem label="Executor" value="Codex Agent" tone="good" />
          </div>
        </Card>

        <Card className="panel edit-flow-plan-panel">
          <div className="edit-flow-panel-head">
            <div>
              <h2>Flow Plan</h2>
              <p>{editFlowPlan ? `${editFlowPlan.steps?.length || 0} steps · ${editFlowPlan.editRuleCategory}` : '等待 Codex Agent 写入执行计划'}</p>
            </div>
          </div>

          {editFlowPlan ? (
            <div className="edit-flow-plan-body">
              <div className="edit-flow-plan-summary">
                <strong>{`${editFlowPlan.steps?.length || 0} 个步骤 · ${formatEditFlowRunStatus(editFlowPlan.status)}`}</strong>
                <span>{`${editFlowPlan.editRuleHash?.slice(0, 12) || 'no-hash'} · ${editFlowPlan.status}`}</span>
              </div>
              <details className="edit-flow-plan-details">
                <summary>查看计划说明与假设</summary>
                {editFlowPlan.summary ? <p>{editFlowPlan.summary}</p> : null}
                {(editFlowPlan.assumptions || []).length > 0 ? (
                  <div className="edit-flow-assumptions">
                    {editFlowPlan.assumptions.map(item => <div key={item}>{item}</div>)}
                  </div>
                ) : null}
              </details>
            </div>
          ) : (
            <EmptyPanel title="还没有 Flow Plan" detail="保存 Edit 初始化后，由 Codex Agent 生成并写入 edits/<editId>/planning/flow-plan.json。" />
          )}
        </Card>
      </div>

      <details className="compact-disclosure edit-maintenance-disclosure">
        <summary>
          <div className="compact-disclosure-copy">
            <strong>Resolve 剪辑工程维护</strong>
            <span>{latestEditDrp?.createdAt ? `最近快照 ${latestEditDrp.createdAt}` : (editResolveProject?.resolveProjectName || '尚未生成剪辑工程快照')}</span>
          </div>
          <Tag>按需展开</Tag>
        </summary>
      <Card className="panel edit-resolve-drp-panel">
        <div className="edit-flow-panel-head">
          <div>
            <h2>Resolve 剪辑工程维护</h2>
            <p>{editResolveProject?.resolveProjectName || '等待剪辑工程命名'}</p>
          </div>
          <div className="inline-actions">
            <Button
              type={installResolveAssetsBusy || typeof onInstallResolveAssets !== 'function' ? 'disabled' : 'default'}
              disabled={installResolveAssetsBusy || typeof onInstallResolveAssets !== 'function'}
              onClick={() => onInstallResolveAssets?.({ editId })}
            >
              {installResolveAssetsBusy ? '安装中…' : '安装/更新插件与效果'}
            </Button>
            <Button
              type={relinkResolveBusy || installResolveAssetsBusy || typeof onRelinkResolveMedia !== 'function' ? 'disabled' : 'default'}
              disabled={relinkResolveBusy || installResolveAssetsBusy || typeof onRelinkResolveMedia !== 'function'}
              onClick={() => onRelinkResolveMedia?.({ editId })}
            >
              {relinkResolveBusy ? '安装校验并重链中…' : '重链素材路径'}
            </Button>
            <Button
              type={saveResolveBusy || typeof onSaveResolveSnapshot !== 'function' ? 'disabled' : 'default'}
              disabled={saveResolveBusy || typeof onSaveResolveSnapshot !== 'function'}
              onClick={() => onSaveResolveSnapshot?.({ editId, retention: 'latest-only' })}
            >
              {saveResolveBusy ? '保存中…' : '覆盖最新'}
            </Button>
            <Button
              type={saveResolveBusy || typeof onSaveResolveSnapshot !== 'function' ? 'disabled' : 'default'}
              disabled={saveResolveBusy || typeof onSaveResolveSnapshot !== 'function'}
              onClick={() => onSaveResolveSnapshot?.({ editId, retention: 'archive' })}
            >
              归档快照
            </Button>
          </div>
        </div>
        {resolveAssetsSummary ? (
          <div className={`edit-resolve-relink-summary ${resolveAssetsSummary.status === 'blocked' ? 'edit-resolve-relink-summary-error' : resolveAssetsSummary.status === 'needs-install' ? 'edit-resolve-relink-summary-warning' : ''}`}>
            <span>{`插件/效果 ${formatResolveAssetsStatus(resolveAssetsSummary)}`}</span>
            <span>{`已安装 ${resolveAssetsSummary.summary?.installed ?? 0}/${resolveAssetsSummary.summary?.total ?? 0}`}</span>
            <span>{`更新 ${resolveAssetsSummary.summary?.updated ?? 0}`}</span>
          </div>
        ) : null}
        {editResolveAssetsError ? (
          <div className="edit-resolve-relink-summary edit-resolve-relink-summary-error">
            <span>{editResolveAssetsError}</span>
          </div>
        ) : null}
        {resolveAssetsWarningText ? (
          <div className="edit-resolve-relink-summary edit-resolve-relink-summary-warning">
            <span>{resolveAssetsWarningText}</span>
          </div>
        ) : null}
        {relinkResolveBusy ? (
          <div className="edit-resolve-relink-summary">
            <span>正在安装/更新 Resolve 插件与效果，并重链 Media Pool 素材路径…</span>
          </div>
        ) : null}
        {editRelinkError ? (
          <div className="edit-resolve-relink-summary edit-resolve-relink-summary-error">
            <span>{editRelinkError}</span>
          </div>
        ) : null}
        {editRelinkSummary ? (
          <div className="edit-resolve-relink-summary">
            <span>{`插件 ${formatResolveAssetsStatus(editRelinkSummary.resolveAssetsInstall)}`}</span>
            <span>{`素材池 ${editRelinkSummary.totalMediaItems ?? 0}`}</span>
            <span>{`重链 ${editRelinkSummary.relinked ?? 0}`}</span>
            <span>{`配音 ${formatVoiceoverRelinkSummary(editRelinkSummary.voiceover)}`}</span>
            <span>{`音频 ${formatExternalAudioRelinkSummary(editRelinkSummary.audio)}`}</span>
            <span>{`旧路径 ${editRelinkSummary.oldPathRemaining ?? 0}`}</span>
            <span>{`不可读 ${editRelinkSummary.localUnreadable ?? 0}`}</span>
            <span>{`缺失目标 ${editRelinkSummary.missingTargetCount ?? 0}`}</span>
            <span>{`未映射 ${editRelinkSummary.unmappedCount ?? 0}`}</span>
            <span>{`跳过复合 ${editRelinkSummary.skippedNonFileCount ?? 0}`}</span>
            <span>{`时间线旧路径 ${editRelinkSummary.timelineOldPathRemaining ?? 0}`}</span>
          </div>
        ) : null}
        {editRelinkWarningText ? (
          <div className="edit-resolve-relink-summary edit-resolve-relink-summary-warning">
            <span>{editRelinkWarningText}</span>
          </div>
        ) : null}
        <div className="color-drp-panel">
          <div className="color-drp-copy">
            <strong>Resolve [Edit] DRP 快照</strong>
            <div className="muted">
              {latestEditDrp?.snapshotPath
                ? `latest · ${latestEditDrp.latestPath || latestEditDrp.snapshotPath}`
                : '还没有剪辑 DRP。Resolve scripting 不可用时，用 File -> Export Project... 保存后在这里登记。'}
            </div>
            {latestEditDrp?.createdAt ? (
              <div className="muted">
                {`${latestEditDrp.mode || 'auto'} · ${latestEditDrp.retention || 'archive'} · ${latestEditDrp.createdAt} · ${latestEditDrp.projectName || editResolveProject?.resolveProjectName || ''}`}
              </div>
            ) : null}
          </div>
          <div className="color-drp-register">
            <label className="edit-flow-field">
              <span>登记外部 DRP</span>
              <input
                value={externalDrpPath}
                onChange={event => setExternalDrpPath(event.target.value)}
                placeholder=".../edits/resolve-projects/.../snapshots/project.drp"
                disabled={registerResolveBusy}
              />
            </label>
            <Button
              type={externalDrpPath.trim() && !registerResolveBusy ? 'default' : 'disabled'}
              disabled={!externalDrpPath.trim() || registerResolveBusy || typeof onRegisterResolveSnapshot !== 'function'}
              onClick={() => {
                onRegisterResolveSnapshot?.({ editId, path: externalDrpPath.trim() });
                setExternalDrpPath('');
              }}
            >
              {registerResolveBusy ? '登记中…' : '登记'}
            </Button>
          </div>
        </div>
      </Card>
      </details>

      <div className="edit-flow-step-section">
        <div className="edit-flow-section-head">
          <div>
            <h2>Step 列表</h2>
            <p>这里只读展示 Flow Plan 声明的 capability、输入、输出和运行记录。</p>
          </div>
        </div>

        <div className="edit-flow-steps">
        {(editFlowPlan?.steps || []).map((step, index) => {
          const capability = registry.get(step.capabilityId);
          const latestRun = latestRunByStep.get(step.id);
          const runStatus = latestRun?.status || 'pending';
          const shouldStayOpen = step.id === firstActionableStepId
            || ['running', 'failed', 'stale', 'awaiting_review'].includes(runStatus);
          const isExpanded = shouldStayOpen || Boolean(expandedStepIds[step.id]);
          return (
            <Card key={step.id} className={`panel edit-flow-step edit-flow-step-${runStatus.replace(/_/gu, '-')} ${isExpanded ? 'is-expanded' : 'is-collapsed'}`}>
              <div className="edit-flow-step-grid">
                <div className="edit-flow-step-index">{String(index + 1).padStart(2, '0')}</div>

                <div className="edit-flow-step-body">
                  <div className="edit-flow-step-title">
                    <div>
                      <h2>{step.title || step.capabilityId}</h2>
                      <span>{`${step.id} / ${step.capabilityId}`}</span>
                    </div>
                    <div className="edit-flow-step-title-actions">
                      <EditFlowStatusItem label="状态" value={formatEditFlowRunStatus(runStatus)} tone={runStatusToTone(runStatus)} />
                      {!shouldStayOpen ? (
                        <button
                          type="button"
                          className="edit-flow-step-toggle"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedStepIds(previous => ({
                            ...previous,
                            [step.id]: !previous[step.id],
                          }))}
                        >
                          {isExpanded ? '收起' : '展开'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {isExpanded ? <p>{capability?.summary || step.notes?.join(' ') || 'No capability summary.'}</p> : null}
                  {isExpanded && (step.notes || []).length > 0 ? (
                    <div className="edit-flow-notes">
                      {step.notes.map(note => <span key={note}>{note}</span>)}
                    </div>
                  ) : null}

                  {isExpanded ? <div className="edit-flow-ref-grid">
                    <RefList title="输入" refs={step.inputRefs} />
                    <RefList title="输出" refs={step.outputRefs} />
                  </div> : null}

                  {isExpanded && latestRun?.error ? (
                    <div className="edit-flow-run-message edit-flow-run-message-danger">
                      {latestRun.error}
                    </div>
                  ) : null}
                  {isExpanded && latestRun?.outputPaths?.length ? (
                    <div className="edit-flow-output-paths">{`输出：${latestRun.outputPaths.join(', ')}`}</div>
                  ) : null}
                  {isExpanded && hasRunSummary(latestRun?.summary) ? (
                    <RunSummary summary={latestRun.summary} />
                  ) : null}
                </div>

                {isExpanded ? <div className="edit-flow-step-side">
                  <div className="edit-flow-step-meta">
                    <span>{formatEditFlowExecution(step.execution)}</span>
                    {step.execution?.mode === 'sharded-agent' ? <span>{`shard: ${step.execution.shardBy}`}</span> : null}
                    {step.execution?.shardPacking ? <span>{formatShardPacking(step.execution.shardPacking)}</span> : null}
                    {step.execution?.codexSubagentProfile ? <span>{formatCodexSubagentProfile(step.execution.codexSubagentProfile)}</span> : null}
                    <span>{step.runner || capability?.defaultRunner || 'runner'}</span>
                    <span>{step.gate === 'human' ? 'human gate' : 'no gate'}</span>
                  </div>
                </div> : null}
              </div>
            </Card>
          );
        })}
        {!(editFlowPlan?.steps || []).length ? (
          <EmptyPanel title="暂无 step" detail="Codex Agent 写入 Flow Plan 后会显示能力列表。" />
        ) : null}
        </div>
      </div>
    </div>
  );
}

function RefList({ title, refs }) {
  const items = refs || [];
  return (
    <details className="edit-flow-ref-list" open={items.length <= 2}>
      <summary>
        <strong>{title}</strong>
        <span>{`${items.length} refs`}</span>
      </summary>
      {items.length > 0 ? (
        <ul>
          {items.map(ref => <li key={ref}><code>{ref}</code></li>)}
        </ul>
      ) : (
        <div className="muted">无</div>
      )}
    </details>
  );
}

function RunSummary({ summary }) {
  const pairs = formatRunSummaryPairs(summary);
  if (!pairs.length) return null;
  return (
    <div className="edit-flow-run-summary">
      {pairs.map(pair => (
        <span key={pair.label}>
          <strong>{pair.label}</strong>
          <em>{pair.value}</em>
        </span>
      ))}
    </div>
  );
}

function EditFlowStatusItem({ label, value, tone }) {
  return (
    <span className={`edit-flow-status-item edit-flow-status-${tone || 'neutral'}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function hasRunSummary(summary) {
  return summary && typeof summary === 'object' && Object.keys(summary).length > 0;
}

function formatRunSummaryPairs(summary) {
  if (!summary || typeof summary !== 'object') return [];
  const pairs = [];
  [
    ['imported', '导入'],
    ['reused', '复用'],
    ['moved', '移动'],
    ['eventFolderCount', '事件文件夹'],
    ['mediaItemCount', '素材'],
    ['clipCount', '片段'],
  ].forEach(([key, label]) => {
    if (summary[key] != null) pairs.push({ label, value: String(summary[key]) });
  });
  const sourceRange = summary.sourceRangeValidation;
  if (sourceRange && typeof sourceRange === 'object') {
    pairs.push({
      label: 'source range',
      value: `${sourceRange.passed || 0}/${sourceRange.checked || 0}`,
    });
  }
  const stillDuration = summary.stillDurationValidation;
  if (stillDuration && typeof stillDuration === 'object' && stillDuration.checked) {
    pairs.push({
      label: '图片时长',
      value: `${stillDuration.passed || 0}/${stillDuration.checked || 0}`,
    });
  }
  if (summary.timelineName) pairs.push({ label: 'Resolve Timeline', value: String(summary.timelineName) });
  if (summary.namespace) pairs.push({ label: 'Media Pool', value: String(summary.namespace) });
  return pairs;
}

function runStatusToTone(status) {
  if (status === 'completed') return 'good';
  if (status === 'failed' || status === 'stale') return 'bad';
  if (status === 'awaiting_review' || status === 'running') return 'warn';
  return 'neutral';
}

function formatEditFlowRunStatus(status) {
  const mapping = {
    pending: '待运行',
    running: '运行中',
    awaiting_review: '待确认',
    completed: '已完成',
    failed: '失败',
    stale: '已过期',
  };
  return mapping[status] || status;
}

function formatEditFlowExecution(execution) {
  if (!execution) return 'single Agent';
  if (execution.mode === 'sharded-agent') return 'SubAgent';
  if (execution.mode === 'deterministic') return 'deterministic';
  if (execution.mode === 'manual') return 'manual';
  return 'single Agent';
}

function formatShardPacking(packing) {
  if (!packing) return '';
  const metric = packing.metric === 'materialRefCount' ? 'material refs' : 'events';
  return `${packing.base} pack <= ${packing.maxPerShard} ${metric}`;
}

function formatCodexSubagentProfile(profile) {
  if (!profile) return '';
  return `Codex ${profile.reasoningEffort || 'high'} / fork ${profile.forkContext ? 'on' : 'off'} / ${profile.speed || 'standard'}`;
}

function ScriptPage({
  config,
  editFlowPlan,
  editRules,
  styleSources,
  setScriptBrief,
  saveScriptBriefReview,
  saveScriptBriefEditRuleCategory,
  saveScriptBriefStyleCategory,
  authorizeScriptBriefRegeneration,
  busy,
  jobs,
  projectId,
  onRun,
  onWorkflowTransition,
}) {
  const latestJob = null;
  const activeScriptJobs = [];
  const availableRuleCategories = editRules?.categories || [];
  const availableStyleCategories = styleSources?.categories || [];
  const workflowState = config?.workflowState || 'choose_style';
  const hasSelectedEditRuleCategory = Boolean(config?.editRuleCategory);
  const hasValidEditRuleCategory = hasSelectedEditRuleCategory
    && availableRuleCategories.some(category => category.categoryId === config?.editRuleCategory);
  const hasValidStyleCategory = !config?.styleCategory
    || availableStyleCategories.some(category => category.categoryId === config?.styleCategory);
  const canPrepare = false;
  const workflowPrompt = buildScriptWorkflowPrompt({
    config,
    availableCategories: availableRuleCategories,
    hasSelectedEditRuleCategory,
    hasValidEditRuleCategory,
    hasValidStyleCategory,
    workflowState,
    latestJob,
  });
  const previousWorkflowStateRef = React.useRef(null);

  useEffect(() => {
    const previousWorkflowState = previousWorkflowStateRef.current;
    if (
      previousWorkflowState
      && previousWorkflowState !== workflowState
      && shouldAutoOpenScriptWorkflowDialog(workflowState)
    ) {
      onWorkflowTransition?.(workflowState);
    }
    previousWorkflowStateRef.current = workflowState;
  }, [onWorkflowTransition, workflowState]);

  return (
    <div className="route-page">
      <RouteIntro
        title="脚本"
        subtitle="先在这里选剪辑规则并审查 brief，再点“准备给 Agent”；风格参考只影响最终旁白和字幕表达。"
      />
      {workflowPrompt ? (
        <WorkflowPrompt
          eyebrow={workflowPrompt.eyebrow}
          title={workflowPrompt.title}
          body={workflowPrompt.body}
          tone={workflowPrompt.tone}
          detail={workflowPrompt.detail}
        />
      ) : null}
      <Card className="panel">
        <div className="section-header">
          <h2>Script Preparation</h2>
          <Tag>{latestJob ? formatScriptJobStatus(latestJob.status) : '未运行'}</Tag>
        </div>
        <p className="muted">这里不会后台自动写稿。脚本页只保留旧 brief 审查语义；正式剪辑初始化和产物审查请使用 /edit。</p>
        {!availableRuleCategories.length ? (
          <p className="muted">Workspace 剪辑规则库当前没有可选分类；请先补 `config/edit-rules/*.md`。</p>
        ) : null}
        {hasValidEditRuleCategory ? (
          <div className="job-item">
            <div>
              <strong>Edit Flow</strong>
              <div className="muted">Flow Plan 与剪辑产物由 Codex Agent 维护；旧脚本页不再提供生成、确认或运行入口。</div>
            </div>
            <Tag>{editFlowPlan?.status || 'read-only'}</Tag>
          </div>
        ) : null}
        {latestJob ? (
          <div className="job-item">
            <div>
              <strong>{latestJob.status === 'awaiting_agent' ? '准备完成' : '最近一次 Script Preparation'}</strong>
              <div className="muted">{describeScriptJob(latestJob)}</div>
            </div>
            <Tag>{formatScriptJobStatus(latestJob.status)}</Tag>
          </div>
        ) : null}
        <div className="actions">
            <Button
              type="disabled"
              disabled
              onClick={onRun}
            >
              准备入口已迁移
            </Button>
        </div>
        <div className="muted">{`活跃 job ${activeScriptJobs.length}`}</div>
      </Card>
      <ScriptBriefEditor
        config={config}
        editRules={editRules}
        styleSources={styleSources}
        setConfig={setScriptBrief}
        onSave={saveScriptBriefReview}
        onEditRuleCategoryChange={saveScriptBriefEditRuleCategory}
        onStyleCategoryChange={saveScriptBriefStyleCategory}
        onRequestRegenerate={authorizeScriptBriefRegeneration}
        busy={busy['script-brief']}
        autoSaveBusy={busy['script-brief:edit-rule'] || busy['script-brief:style']}
        regenerateBusy={busy['script-brief:regenerate']}
      />
    </div>
  );
}

function TimelineExportPage({ capabilities }) {
  const jobs = capabilities?.jobs || [];
  const relevantJobs = jobs.filter(job => ['timeline', 'export-jianying', 'export-resolve'].includes(job.jobType));
  const resolveCapability = relevantJobs.find(job => job.jobType === 'export-resolve');
  return (
    <div className="route-page timeline-export-page">
      <RouteIntro title="时间线与导出" subtitle="整理当前时间线、目标 NLE 与导出 blocker；不新增业务 runner。" />
      <section className="timeline-readiness-hero">
        <div><div className="eyebrow">Readiness</div><h2>{resolveCapability?.supported ? '已具备 Resolve 导出能力' : '等待时间线或宿主条件'}</h2><p>正式导出继续以 confirmed Flow Plan 产物、Resolve timeline 与明确的新输出目录为准。</p></div>
        <div className="timeline-readiness-state"><span>目标</span><strong>Resolve / Jianying</strong><Tag color={resolveCapability?.supported ? 'success' : 'warning'}>{resolveCapability?.supported ? 'ready' : 'blocked'}</Tag></div>
      </section>
      <div className="timeline-export-grid">
        <Card className="panel">
          <div className="section-header"><h2>能力状态</h2><Tag>{relevantJobs.length}</Tag></div>
          <div className="stack-list">
            {relevantJobs.map(job => <div key={job.jobType} className="job-item"><div><strong>{job.jobType}</strong><div className="muted">{job.executionMode || '未声明执行模式'}</div></div><Tag color={job.supported ? 'success' : 'warning'}>{job.supported ? 'supported' : 'blocked'}</Tag></div>)}
            {relevantJobs.length === 0 ? <p className="muted">Supervisor 当前未声明 timeline / export capability。</p> : null}
          </div>
        </Card>
        <Card className="panel">
          <div className="section-header"><h2>正式闸门</h2><Tag>只读</Tag></div>
          <div className="timeline-gate-list">
            <div><span>01</span><strong>Flow Plan 产物</strong><small>确认当前 step 的 declared outputs</small></div>
            <div><span>02</span><strong>目标工程</strong><small>核对 Resolve 项目与时间线身份</small></div>
            <div><span>03</span><strong>输出路径</strong><small>必须是新的、不覆盖既有内容的目标</small></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ProjectPage({
  services,
  busy,
  onControlMl,
  reviews,
  setReviews,
  resolveReview,
  currentProject,
  asrConfig,
  setAsrConfig,
  onSaveAsrConfig,
  transcriptGlossary,
  setTranscriptGlossary,
  onSaveTranscriptGlossary,
}) {
  const runningCount = services.filter(service => service.status === 'running').length;
  return (
    <div className="route-page project-page">
      <RouteIntro title="项目" subtitle="集中查看项目身份、服务真相、Review Queue 与维护入口。" />
      <section className="project-summary-hero">
        <div><div className="eyebrow">Project</div><h2>{currentProject?.project?.name || '当前项目'}</h2><code>{currentProject?.projectId || 'workspace'}</code></div>
        <div><span>服务</span><strong>{`${runningCount}/${services.length}`}</strong><small>running</small></div>
        <div><span>Review</span><strong>{reviews.filter(review => review.status === 'open').length}</strong><small>open</small></div>
      </section>
      <Card className="panel">
        <div className="section-header">
          <h2>服务诊断</h2>
          <Tag>{currentProject?.projectId || 'workspace'}</Tag>
        </div>
        <div className="stack-list">
          {services.map(service => (
            <div key={service.name} className="job-item">
              <div>
                <strong>{service.name}</strong>
                <div className="muted">{service.url || service.cwd || 'no url'}</div>
                {service.listenerPid ? <div className="muted">{`PID ${service.listenerPid}`}</div> : null}
              </div>
              <Tag>{service.status}</Tag>
            </div>
          ))}
        </div>
        <div className="actions">
          <Button
            type={busy['ml:start'] ? 'disabled' : 'primary'}
            disabled={busy['ml:start']}
            onClick={() => onControlMl('start')}
          >
            {busy['ml:start'] ? '处理中…' : '启动 ML'}
          </Button>
          <Button
            type={busy['ml:restart'] ? 'disabled' : 'warning'}
            disabled={busy['ml:restart']}
            onClick={() => onControlMl('restart')}
          >
            {busy['ml:restart'] ? '处理中…' : '重启 ML'}
          </Button>
          <Button
            type={busy['ml:stop'] ? 'disabled' : 'error'}
            disabled={busy['ml:stop']}
            onClick={() => onControlMl('stop')}
          >
            {busy['ml:stop'] ? '处理中…' : '停止 ML'}
          </Button>
        </div>
      </Card>
      <AsrConfigEditor
        config={asrConfig}
        setConfig={setAsrConfig}
        onSave={onSaveAsrConfig}
        busy={busy['workspace:asr-config']}
        runtime={services.find(service => service.name === 'ml')?.health?.asr || null}
      />
      <TranscriptGlossaryEditor
        config={transcriptGlossary}
        setConfig={setTranscriptGlossary}
        onSave={onSaveTranscriptGlossary}
        busy={busy['workspace:transcript-glossary']}
      />
      <ReviewQueuePanel
        reviews={reviews}
        setReviews={setReviews}
        onResolve={resolveReview}
        title="Review Queue"
        filter={review => review.kind !== 'transcript-correction'}
      />
    </div>
  );
}

function MonitorLoader({ kind, projectId, categoryId, emptyLabel, toolbar, afterMonitor }) {
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const next = kind === 'style'
          ? await fetchStyleMonitor(categoryId)
          : !projectId
            ? null
            : await fetchAnalyzeMonitor(projectId);
        if (active) {
          setModel(next);
          setError('');
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [kind, projectId, categoryId]);

  const displayModel = kind === 'analyze' ? normalizeAnalyzeAsrLifecycleForDisplay(model) : model;
  return (
    <div className="route-page">
      {error ? <div className="error-banner">{error}</div> : null}
      <MonitorPage
        model={displayModel}
        emptyLabel={emptyLabel}
        toolbar={typeof toolbar === 'function' ? toolbar(displayModel) : toolbar}
        afterMonitor={typeof afterMonitor === 'function' ? afterMonitor(displayModel) : afterMonitor}
      />
    </div>
  );
}

export function normalizeAnalyzeAsrLifecycleForDisplay(model) {
  if (!model?.asr) return model;
  const postAsrSteps = new Set([
    'transcript-segmentation',
    'semantic-transcript-segmentation',
    'finalize',
    'fine-scan-prefetch',
    'fine-scan-recognition',
    'chronology',
  ]);
  const released = model.asr.lifecycle === 'released'
    || (
      model.asr.configuredBackend === 'qwen3'
      && model.asr.actualBackend === 'qwen3'
      && model.latestJob?.jobType === 'analyze'
      && model.latestJob?.status === 'running'
      && postAsrSteps.has(model.progress?.stepKey)
    );
  if (!released) return model;
  return {
    ...model,
    asr: {
      ...model.asr,
      lifecycle: 'released',
      blocker: null,
      statusDetail: model.asr.statusDetail
        || '本轮 ASR 与字级对齐已完成，独立 worker 已停止并释放显存；字幕拆分不占用 ML，后续视觉阶段再加载主 VLM。',
    },
    chips: (model.chips || []).map(chip => (
      typeof chip?.label === 'string' && chip.label.startsWith('ASR ')
        ? { ...chip, tone: 'ok' }
        : chip
    )),
  };
}

function renderAnalyzeToolbarMeta(model, projectProgress) {
  const pipelines = model?.pipelines || [];
  const activePipeline = pipelines.find(item => item.kind === model?.progress?.stepKey)
    || pipelines.find(item => item.kind === 'audio-analysis' && ((item.activeLocal || 0) > 0 || (item.activeAsr || 0) > 0))
    || pipelines.find(item => item.kind === 'coarse-scan' && (item.active || 0) > 0)
    || pipelines.find(item => item.kind === 'fine-scan' && (((item.activePrefetch || 0) > 0) || ((item.activeRecognition || 0) > 0)))
    || pipelines[0];
  if (activePipeline?.kind === 'coarse-scan') {
    return (
      <>
        <span>{`粗扫 ${activePipeline.completed || 0}/${activePipeline.total || 0}`}</span>
        <span>{`worker ${activePipeline.active || 0}/${activePipeline.targetConcurrency || 0}`}</span>
      </>
    );
  }
  if (activePipeline?.kind === 'audio-analysis') {
    return (
      <>
        <span>{`音频 ${activePipeline.completed || 0}/${activePipeline.total || 0}`}</span>
        <span>{`local ${activePipeline.activeLocal || 0}/${activePipeline.targetLocalConcurrency || 0}`}</span>
        <span>{`ASR ${activePipeline.activeAsr || 0}/${activePipeline.targetAsrConcurrency || 0}`}</span>
      </>
    );
  }
  if (activePipeline?.kind === 'fine-scan') {
    return (
      <>
        <span>{`识别 ${activePipeline.recognized || 0}/${activePipeline.total || 0}`}</span>
        <span>{`预抽 ${activePipeline.prefetched || 0}/${activePipeline.total || 0}`}</span>
      </>
    );
  }
  if (projectProgress) {
    return <span>{`${projectProgress.current || 0}/${projectProgress.total || 0}`}</span>;
  }
  return null;
}

export function pickConsoleProjectId(projects, jobs, storedProjectId) {
  if (!projects.length) {
    return '';
  }
  if (storedProjectId && projects.some(project => project.projectId === storedProjectId)) {
    return storedProjectId;
  }
  const activeProjectId = pickLatestActiveProjectId(projects, jobs);
  if (activeProjectId) {
    return activeProjectId;
  }
  return projects[0]?.projectId || '';
}

function formatEditRelinkMessage(result) {
  const summary = result?.hostSummary || {};
  const relinked = summary.relinked ?? 0;
  const oldRemaining = summary.oldPathRemaining ?? 0;
  const unreadable = summary.localUnreadable ?? 0;
  const missing = summary.missingTargetCount ?? 0;
  const unmapped = summary.unmappedCount ?? 0;
  const resolveAssets = summary.resolveAssetsInstall || result?.resolveAssetsInstall;
  return `剪辑工程素材重链完成：${relinked} 个，旧路径 ${oldRemaining}，不可读 ${unreadable}，缺失目标 ${missing}，未映射 ${unmapped}；插件/效果 ${formatResolveAssetsStatus(resolveAssets)}；配音 ${formatVoiceoverRelinkSummary(summary.voiceover)}；音频 ${formatExternalAudioRelinkSummary(summary.audio)}`;
}

function formatResolveAssetsMessage(result) {
  return `Resolve 插件/效果安装完成：${formatResolveAssetsStatus(result)}`;
}

function formatResolveAssetsError(caught) {
  const baseMessage = caught instanceof Error ? caught.message : String(caught);
  const details = caught?.details?.summary ? caught.details : caught?.details?.details;
  if (!details?.summary) return baseMessage;
  return `${baseMessage}；${formatResolveAssetsStatus(details)}`;
}

function formatResolveAssetsStatus(result) {
  if (!result) return '未知';
  const summary = result.summary || {};
  const total = summary.total ?? 0;
  const installed = summary.installed ?? 0;
  if (result.status === 'ready') return `就绪 ${installed}/${total}`;
  if (result.status === 'needs-install') {
    return `需安装 ${installed}/${total}，缺失 ${summary.missing ?? 0}，过期 ${summary.outdated ?? 0}`;
  }
  if (result.status === 'blocked') {
    return `阻塞 ${installed}/${total}，失败 ${summary.failed ?? 0}，缺源 ${summary.sourceMissing ?? 0}`;
  }
  return `${result.status || 'unknown'} ${installed}/${total}`;
}

function formatResolveAssetsWarning(result) {
  if (!result) return '';
  if (result.status === 'ready') return '';
  const errors = (result.errors || []).slice(0, 2).filter(Boolean);
  if (result.status === 'blocked') {
    return `Resolve 插件/效果安装阻塞：${formatResolveAssetsStatus(result)}${errors.length ? `；${errors.join('；')}` : ''}`;
  }
  return `Resolve 插件/效果需要安装或更新：${formatResolveAssetsStatus(result)}`;
}

function formatEditRelinkError(caught) {
  const baseMessage = caught instanceof Error ? caught.message : String(caught);
  const hostDetails = caught?.details?.details || caught?.details || {};
  const missing = hostDetails.missingTargetCount;
  const unmapped = hostDetails.unmappedCount;
  if (missing === undefined && unmapped === undefined) return baseMessage;
  const samples = [
    ...(hostDetails.missingTargetSamples || []).slice(0, 2).map(item => item.target || item.path || item.name),
    ...(hostDetails.unmappedSamples || []).slice(0, 2).map(item => item.path || item.name),
  ].filter(Boolean);
  const suffix = samples.length > 0 ? `；样本：${samples.join('；')}` : '';
  return `${baseMessage}；缺失目标 ${missing ?? 0}，未映射 ${unmapped ?? 0}${suffix}`;
}

function formatEditRelinkWarnings(summary) {
  if (!summary) return '';
  const missing = summary.missingTargetCount ?? 0;
  const unmapped = summary.unmappedCount ?? 0;
  const oldRemaining = summary.oldPathRemaining ?? 0;
  const unreadable = summary.localUnreadable ?? 0;
  const timelineMissing = summary.timelineMissingTargetCount ?? 0;
  const timelineUnmapped = summary.timelineUnmappedCount ?? 0;
  const timelineOld = summary.timelineOldPathRemaining ?? 0;
  const timelineUnreadable = summary.timelineUnreadable ?? 0;
  const resolveAssetsWarning = formatResolveAssetsWarning(summary.resolveAssetsInstall);
  const voiceoverWarning = formatVoiceoverRelinkWarning(summary.voiceover);
  const audioWarning = formatExternalAudioRelinkWarning(summary.audio, '音频');
  if (
    missing
    + unmapped
    + oldRemaining
    + unreadable
    + timelineMissing
    + timelineUnmapped
    + timelineOld
    + timelineUnreadable <= 0
    && !resolveAssetsWarning
    && !voiceoverWarning
    && !audioWarning
  ) return '';
  const samples = [
    ...(summary.missingTargetSamples || []).slice(0, 3).map(item => item.target || item.path || item.name),
    ...(summary.unmappedSamples || []).slice(0, 3).map(item => item.path || item.name),
  ].filter(Boolean);
  const sampleText = samples.length > 0 ? `；样本：${samples.join('；')}` : '';
  const externalWarnings = [resolveAssetsWarning, voiceoverWarning, audioWarning].filter(Boolean).map(text => `；${text}`).join('');
  return `重链完成，但仍有警告：旧路径 ${oldRemaining}，不可读 ${unreadable}，缺失目标 ${missing}，未映射 ${unmapped}，时间线旧路径 ${timelineOld}，时间线不可读 ${timelineUnreadable}，时间线缺失目标 ${timelineMissing}，时间线未映射 ${timelineUnmapped}${externalWarnings}${sampleText}`;
}

function formatVoiceoverRelinkSummary(summary) {
  return formatExternalAudioRelinkSummary(summary);
}

function formatExternalAudioRelinkSummary(summary) {
  if (!summary || summary.configured === false) return '未配置';
  if (summary.skipped) return `跳过：${formatVoiceoverRelinkReason(summary.reason)}`;
  const relinked = summary.relinked ?? 0;
  const oldRemaining = summary.oldPathRemaining ?? 0;
  const unmapped = summary.unmappedCount ?? 0;
  return `重链 ${relinked}，旧路径 ${oldRemaining}，未映射 ${unmapped}`;
}

function formatVoiceoverRelinkWarning(summary) {
  return formatExternalAudioRelinkWarning(summary, '配音');
}

function formatExternalAudioRelinkWarning(summary, label) {
  if (!summary || summary.configured === false) return '';
  if (summary.skipped) return `${label}重链跳过：${formatVoiceoverRelinkReason(summary.reason)}`;
  const missing = summary.missingTargetCount ?? 0;
  const unmapped = summary.unmappedCount ?? 0;
  const oldRemaining = summary.oldPathRemaining ?? 0;
  const timelineOld = summary.timelineOldPathRemaining ?? 0;
  if (missing + unmapped + oldRemaining + timelineOld <= 0) return '';
  return `${label}警告：缺失目标 ${missing}，未映射 ${unmapped}，旧路径 ${oldRemaining}，时间线旧路径 ${timelineOld}`;
}

function formatVoiceoverRelinkReason(reason) {
  const normalized = String(reason || '').trim();
  if (normalized === 'voiceover_media_not_configured') return '未配置';
  if (normalized === 'voiceover_media_unreadable') return '路径不可读';
  if (normalized === 'voiceover_media_pool_bin_missing') return 'Media Pool 无 Kairos Voiceover';
  if (normalized === 'audio_media_not_configured') return '未配置';
  if (normalized === 'audio_media_unreadable') return '路径不可读';
  if (normalized === 'audio_media_pool_bin_missing') return 'Media Pool 无 Kairos Audio';
  return normalized || '未知原因';
}

function pickLatestActiveProjectId(projects, jobs) {
  const validProjectIds = new Set(projects.map(project => project.projectId));
  const candidates = (jobs || [])
    .filter(job => job.projectId && validProjectIds.has(job.projectId))
    .filter(job => ['running', 'queued', 'blocked'].includes(job.status))
    .sort(compareActiveProjectJobs);
  return candidates[0]?.projectId || '';
}

function compareActiveProjectJobs(left, right) {
  const statusPriority = {
    running: 3,
    queued: 2,
    blocked: 1,
  };
  const statusDiff = (statusPriority[right.status] || 0) - (statusPriority[left.status] || 0);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
}

function buildDuplicateProjectNameSet(projects) {
  const counts = new Map();
  for (const project of projects) {
    const name = project.project?.name || project.projectId;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Set(Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([name]) => name));
}

function formatProjectOptionLabel(project, duplicateProjectNames) {
  const name = project.project?.name || project.projectId;
  if (duplicateProjectNames.has(name)) {
    return `${name} · ${project.projectId}`;
  }
  return name;
}

function formatCountPair(current, total) {
  if (typeof total === 'number' && total > 0) {
    return `${current || 0}/${total}`;
  }
  return String(current || 0);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function formatEtaSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds === 0) return '0s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function resolveProgressPercent(progress) {
  if (!progress) return 0;
  if (typeof progress.percent === 'number') {
    return Math.max(0, Math.min(100, progress.percent));
  }
  if (typeof progress.total === 'number' && progress.total > 0) {
    return Math.max(0, Math.min(100, Math.round(((progress.current || 0) / progress.total) * 100)));
  }
  return progress.status === 'succeeded' ? 100 : 0;
}

function describeChronologyJobTitle(job) {
  if (!job) return 'Chronology 任务';
  if (job.jobType === 'span-rebuild') return '生成候选素材片段与模式';
  if (job.jobType === 'chronology-build') return '生成/刷新编年史';
  if (job.jobType === 'spatial-refresh') return '刷新时空真相';
  return job.jobType;
}

export function isLiveSupervisorJob(job) {
  return ['queued', 'running'].includes(job?.status);
}

function formatIngestGpsJobStatus(status) {
  if (status === 'running') return '运行中';
  if (status === 'queued') return '排队中';
  if (status === 'blocked') return '已阻塞';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  return status || '未运行';
}

function describeIngestGpsJobTitle(job) {
  if (!job) return '尚未运行';
  if (job.jobType === 'gps-refresh') return '最近一次 GPS 缓存刷新';
  return '最近一次 Ingest';
}

function describeIngestGpsJob(job) {
  if (!job) return '当前还没有 ingest / gps-refresh job。';
  if (job.status === 'blocked') {
    return (job.blockers || []).join('；') || '当前刷新被阻塞。';
  }
  if (job.status === 'running' || job.status === 'queued') {
    return job.jobType === 'gps-refresh'
      ? '正在刷新项目 GPX merged cache 与 derived track。'
      : '正在扫描素材并刷新 assets、同源 GPS、derived track 与 Pharos context。';
  }
  if (job.status === 'completed') {
    return job.jobType === 'gps-refresh'
      ? 'GPS 缓存刷新完成；Analyze 会消费最新项目 GPX / derived track。'
      : 'Ingest 已完成；Analyze 可以消费最新 assets / GPS；spans 与 chronology 需在 /chronology 重新生成。';
  }
  if (job.status === 'failed') {
    return job.lastError || '刷新失败，请查看 job 日志。';
  }
  if (job.status === 'stopped') {
    return '刷新已停止。';
  }
  return job.updatedAt || '';
}

function formatScriptJobStatus(status) {
  if (status === 'awaiting_agent') return '等待 Agent';
  if (status === 'running') return '准备中';
  if (status === 'blocked') return '已阻塞';
  if (status === 'completed') return '已完成';
  if (status === 'queued') return '排队中';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  return status || '未运行';
}

function describeScriptJob(job) {
  if (!job) return '当前还没有 script preparation 记录。';
  if (job.status === 'awaiting_agent') {
    return '确定性准备已完成。正式剪辑请进入 /edit 审查 Codex Agent 维护的 Flow Plan 和剪辑产物。';
  }
  if (job.status === 'blocked') {
    return (job.blockers || []).join('；') || '当前脚本准备被阻塞。';
  }
  if (job.status === 'running' || job.status === 'queued') {
    return '正在刷新 deterministic prep 材料。这个阶段不会后台自动写正式脚本。';
  }
  if (job.status === 'failed') {
    return '脚本准备执行失败，请查看 job 日志并重试。';
  }
  return '最近一次 script preparation 已结束。';
}

function buildScriptWorkflowPrompt({
  config,
  availableCategories,
  hasSelectedEditRuleCategory,
  hasValidEditRuleCategory,
  hasValidStyleCategory,
  workflowState,
  latestJob,
}) {
  if (!availableCategories.length) {
    return {
      eyebrow: 'Action Required',
      title: '先准备剪辑规则库',
      body: '当前 workspace 还没有任何可选剪辑规则。先补 config/edit-rules/*.md，再回到这里继续脚本流程。',
      tone: 'warn',
    };
  }
  if (!hasSelectedEditRuleCategory) {
    return {
      eyebrow: 'Action Required',
      title: '先选择剪辑规则',
      body: '在 /edit 初始化 Edit Unit，选择 workspace 剪辑规则和可选风格档案；正式剪辑产物由 Codex Agent 维护。',
      tone: 'warn',
    };
  }
  if (config?.editRuleCategory && !hasValidEditRuleCategory) {
    return {
      eyebrow: 'Blocked',
      title: '当前剪辑规则已失效',
      body: '这个项目记录的剪辑规则在 workspace 规则库里已经不存在了。先在下面重新选择一个有效规则，再继续脚本准备。',
      tone: 'error',
    };
  }
  if (config?.styleCategory && !hasValidStyleCategory) {
    return {
      eyebrow: 'Warning',
      title: '文案风格参考已失效',
      body: '粗剪可以继续；最终旁白 / 字幕表达阶段需要重新选择一个有效文案风格参考。',
      tone: 'warn',
    };
  }
  if (workflowState === 'await_brief_draft') {
    return {
      eyebrow: 'Next Step',
      title: '回到 Agent 生成 overview / brief',
      body: '剪辑规则已经保存。下一步不在这里，而是在 Agent 对话里让它同时起草 material-overview.md 和第一版 script-brief。',
      tone: 'accent',
    };
  }
  if (workflowState === 'review_brief') {
    return {
      eyebrow: 'Next Step',
      title: '先审查并保存 brief',
      body: 'Agent 初版已经生成。请在当前页面修改并保存；保存后，流程才会进入“准备给 Agent”。',
      detail: '如果你决定重生 overview / brief，也请先在这里通过覆盖确认。',
      tone: 'accent',
    };
  }
  if (workflowState === 'ready_to_prepare') {
    return {
      eyebrow: 'Ready',
      title: '现在可以点击“准备给 Agent”了',
      body: 'brief 审查结果已经保存。下一步点击下方按钮刷新确定性材料；这个阶段不会后台自动写正式脚本。',
      tone: 'ok',
    };
  }
  if (workflowState === 'ready_for_agent') {
    return {
      eyebrow: 'Ready',
      title: '进入 Edit Flow',
      body: 'deterministic prep 已完成。正式剪辑从 /edit 初始化的 Edit Unit 进入；Flow Plan、素材召回和时间线产物由 Codex Agent 维护。',
      detail: latestJob ? describeScriptJob(latestJob) : '',
      tone: 'ok',
    };
  }
  if (workflowState === 'script_generated') {
    return {
      eyebrow: 'Done',
      title: '脚本已经生成',
      body: '现在可以继续审稿，或者进入 Timeline 阶段。如果你再次修改 brief，流程会回到 prep 前。',
      tone: 'ok',
    };
  }
  return {
    eyebrow: 'Action Required',
    title: '先选择剪辑规则',
    body: '在下面完成剪辑规则选择后，系统才知道下一步该把你带去哪个脚本流程状态。',
    tone: 'warn',
  };
}

function buildScriptWorkflowDialog(workflowState) {
  if (workflowState === 'await_brief_draft') {
    return {
      title: '剪辑规则已保存',
      body: '下一步请回到 Agent，生成 material-overview.md 和初版 brief。',
      detail: '这个 handoff 已经同步到当前页面顶部的 workflow prompt，不用担心关掉弹窗后找不到下一步。',
    };
  }
  if (workflowState === 'review_brief') {
    return {
      title: '初版 overview / brief 已生成',
      body: '下一步请在 /script 审查、修改并保存 brief。',
      detail: '保存完成后，页面会继续把你引导到“准备给 Agent”。',
    };
  }
  if (workflowState === 'ready_to_prepare') {
    return {
      title: 'brief 已保存',
      body: '下一步请点击“准备给 Agent”。',
      detail: '这个阶段只会刷新确定性材料，不会后台自动写正式脚本。',
    };
  }
  if (workflowState === 'ready_for_agent') {
    return {
      title: '准备已完成',
      body: '下一步请回到 Agent，继续生成正式脚本。',
      detail: '页面顶部的 workflow prompt 也会继续保留这条指引，直到状态变化。',
    };
  }
  if (workflowState === 'script_generated') {
    return {
      title: '脚本已生成',
      body: '现在可以继续审稿，或者进入 Timeline 阶段。',
      detail: '如果你继续修改 brief，流程会自动回退到 prep 前状态。',
    };
  }
  return null;
}

function shouldAutoOpenScriptWorkflowDialog(workflowState) {
  return ['review_brief', 'ready_for_agent', 'script_generated'].includes(workflowState);
}

function StyleMonitorRedirect() {
  const { categoryId } = useParams();
  return <Navigate to={buildStylePath(categoryId)} replace />;
}

function RouteIntro({ title, subtitle }) {
  return (
    <div className="route-intro">
      <div className="eyebrow">Workflow</div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}

function resolveTopLevelPath(pathname) {
  if (pathname.startsWith('/ingest-gps')) return '/ingest-gps';
  if (pathname.startsWith('/color')) return '/color';
  if (pathname.startsWith('/analyze')) return '/analyze';
  if (pathname.startsWith('/chronology')) return '/chronology';
  if (pathname.startsWith('/style')) return '/style';
  if (pathname.startsWith('/edit') || pathname.startsWith('/script')) return '/edit';
  if (pathname.startsWith('/timeline-export')) return '/timeline-export';
  if (pathname.startsWith('/project')) return '/project';
  return '/';
}

export function resolveCurrentStyleCategory(config, search, jobs = []) {
  const params = new URLSearchParams(search || '');
  const requested = params.get('categoryId');
  if (requested && config.categories.some(category => category.categoryId === requested)) {
    return requested;
  }
  const liveCategoryId = (jobs || [])
    .filter(job => job.jobType === 'style-analysis' && ['queued', 'running', 'blocked'].includes(job.status))
    .map(getStyleJobCategoryId)
    .find(categoryId => categoryId && config.categories.some(category => category.categoryId === categoryId));
  if (liveCategoryId) {
    return liveCategoryId;
  }
  return '';
}

function buildStylePath(categoryId) {
  return categoryId
    ? `/style?categoryId=${encodeURIComponent(categoryId)}`
    : '/style';
}

function getStyleJobCategoryId(job) {
  const value = job?.args?.categoryId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getStyleMonitorCategoryId(model) {
  return model?.raw?.category?.categoryId || '';
}

function resolveColorCapability(capabilities) {
  const jobCapability = capabilities?.jobs?.find(job => job.jobType === 'color') || null;
  if (jobCapability) {
    return jobCapability;
  }
  if (typeof capabilities?.color === 'boolean') {
    return { supported: capabilities.color };
  }
  if (capabilities && typeof capabilities.color === 'object') {
    return capabilities.color;
  }
  return null;
}

function buildEditRuleSelectionScriptBriefPayload(brief, editRuleCategory) {
  const workflowState = editRuleCategory ? 'await_brief_draft' : 'choose_style';
  return {
    ...brief,
    editRuleCategory,
    workflowState,
    briefOverwriteApprovedAt: undefined,
    statusText: describeScriptWorkflowState(workflowState),
  };
}

function buildStyleReferenceSelectionScriptBriefPayload(brief, styleCategory) {
  return {
    ...brief,
    styleCategory: styleCategory || undefined,
  };
}

function buildReviewedScriptBriefPayload(brief) {
  const hasAgentDraft = Boolean(brief.lastAgentDraftAt || brief.lastAgentDraftFingerprint);
  const workflowState = !brief.editRuleCategory
    ? 'choose_style'
    : hasAgentDraft
      ? 'ready_to_prepare'
      : 'await_brief_draft';
  return {
    ...brief,
    workflowState,
    lastUserReviewAt: workflowState === 'ready_to_prepare'
      ? new Date().toISOString()
      : undefined,
    statusText: describeScriptWorkflowState(workflowState),
  };
}

function buildRegenerateScriptBriefPayload(brief) {
  return {
    ...brief,
    workflowState: 'await_brief_draft',
    briefOverwriteApprovedAt: new Date().toISOString(),
    statusText: describeScriptWorkflowState('await_brief_draft'),
  };
}

function describeScriptWorkflowState(workflowState) {
  return SCRIPT_WORKFLOW_STATUS_TEXT[workflowState] || SCRIPT_WORKFLOW_STATUS_TEXT.choose_style;
}

function makeSectionSetter(setConfig, sectionKey) {
  return updater => {
    setConfig(current => ({
      ...current,
      [sectionKey]: typeof updater === 'function'
        ? updater(current[sectionKey])
        : updater,
    }));
  };
}

const SCRIPT_WORKFLOW_STATUS_TEXT = {
  choose_style: '请先在 /script 选择剪辑规则。',
  await_brief_draft: '剪辑规则已保存，请回到 Agent 生成 material-overview.md 和初版 brief。',
  review_brief: '初版 overview / brief 已生成，请在 /script 审查并保存。',
  ready_to_prepare: 'brief 已保存，请点击 准备给 Agent。',
  ready_for_agent: '事实刷新与 bundle 索引已完成；正式剪辑请回到 /edit 审查 Codex Agent 产物。',
  script_generated: '脚本已生成，可继续审稿或进入 Timeline。',
};
