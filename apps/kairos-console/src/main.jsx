import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { BrowserRouter as Router, Link, Redirect, Route, Switch } from 'react-router-dom';
import { Button, Card, Menu, MenuItem, Modal, Tag } from 'hana-ui';
import 'hana-ui/hana-style.scss';
import './app.scss';
import {
  controlMl,
  confirmProjectChronology,
  confirmProjectEditFlowPlan,
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
  registerProjectColorDrpSnapshot,
  resolveProjectReview,
  mergeProjectChronologyEvents,
  runProjectColorPreflight,
  saveProjectColorDrpSnapshot,
  saveProjectSection,
  saveWorkspaceStyleConfig,
  startJob,
  startWorkspaceJob,
  splitProjectChronologyEvent,
  updateProjectChronologyEvent,
} from './api.js';
import { EmptyPanel, MonitorPage } from './monitor-page.jsx';
import {
  CaptureTimeOverridesEditor,
  ColorCurrentSummary,
  IngestRootClockEditor,
  ManualItineraryEditor,
  ProjectBriefEditor,
  ReviewQueuePanel,
  ScriptBriefEditor,
  StyleSourcesEditor,
  WorkflowPrompt,
} from './workspace-forms.jsx';

function AppShell() {
  const [status, setStatus] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const storedProjectIdRef = React.useRef(window.localStorage.getItem('kairos.console.projectId') || '');
  const hydratedProjectSelectionRef = React.useRef(false);
  const [projectId, setProjectId] = useState('');
  const [config, setConfig] = useState(null);
  const [colorArchive, setColorArchive] = useState({ roots: [] });
  const [savedConfig, setSavedConfig] = useState(null);
  const [styleSources, setStyleSources] = useState(null);
  const [editRules, setEditRules] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [projectProgress, setProjectProgress] = useState(null);
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [workflowDialog, setWorkflowDialog] = useState(null);
  const [colorOverwriteDialog, setColorOverwriteDialog] = useState(null);

  useEffect(() => {
    refreshStatus();
    refreshStyleSources();
    refreshEditRules();
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

  const projects = status?.projects || [];
  const duplicateProjectNames = useMemo(() => buildDuplicateProjectNameSet(projects), [projects]);
  const currentProject = projects.find(project => project.projectId === projectId) || null;
  const services = status?.services || [];
  const allJobs = status?.jobs || [];
  const activeJobs = useMemo(
    () => allJobs.filter(job => ['queued', 'running', 'blocked'].includes(job.status))
      .filter(job => !(job.jobType === 'script' && job.executionMode === 'agent')),
    [allJobs],
  );
  const liveProjectJobs = useMemo(
    () => activeJobs.filter(job => job.projectId === projectId && ['queued', 'running'].includes(job.status)),
    [activeJobs, projectId],
  );
  const mlService = services.find(service => service.name === 'ml') || null;
  const dashboardService = services.find(service => service.name === 'dashboard') || null;
  const openReviewCount = reviews.filter(review => review.status === 'open').length;

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

  async function refreshStatus() {
    try {
      setStatus(await fetchWorkspaceStatus());
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshProject(nextProjectId) {
    try {
      const [nextConfig, nextReviews, nextColorArchive] = await Promise.all([
        fetchProjectConfig(nextProjectId),
        fetchProjectReviews(nextProjectId),
        fetchProjectColorArchive(nextProjectId).catch(() => ({ roots: [] })),
      ]);
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
      setMessage('已保存 DRP 快照');
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
        jobType === 'script'
          ? ''
          : jobType === 'color' && args.rootId
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

  async function confirmFlowPlan() {
    if (!projectId) return;
    const editId = config?.scriptBrief?.editId || 'main';
    setBusy(current => ({ ...current, 'edit-flow:confirm': true }));
    try {
      await confirmProjectEditFlowPlan(projectId, editId);
      await refreshProject(projectId);
      await refreshStatus();
      setMessage('Flow Plan 已确认');
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(current => ({ ...current, 'edit-flow:confirm': false }));
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

  async function resolveReview(reviewId) {
    if (!projectId) return;
    const target = reviews.find(review => review.id === reviewId);
    if (!target) return;
    try {
      await resolveProjectReview(projectId, reviewId, {
        note: target.note,
        fields: (target.fields || []).map(field => ({ key: field.key, value: field.value })),
        status: 'resolved',
      });
      await refreshProject(projectId);
      setMessage(`已处理 review：${target.title}`);
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  function handleError(caught) {
    const nextMessage = caught instanceof Error ? caught.message : String(caught);
    setError(nextMessage);
  }

  return (
    <Router>
      <Route
        render={routeProps => (
          <div className="console-shell">
            <div className="shell-inner">
              <TopNav {...routeProps} />
              <header className="workspace-bar">
                <div>
                  <div className="eyebrow">Kairos Supervisor</div>
                  <h1>{currentProject?.project?.name || 'Kairos Console'}</h1>
                  {currentProject?.projectId ? <div className="muted">{currentProject.projectId}</div> : null}
                  <p>工作流优先的配置、监控与任务控制台。</p>
                </div>
                <div className="workspace-actions">
                  <select value={projectId} onChange={event => setProjectId(event.target.value)}>
                    {projects.map(project => (
                      <option key={project.projectId} value={project.projectId}>
                        {formatProjectOptionLabel(project, duplicateProjectNames)}
                      </option>
                    ))}
                  </select>
                  <div className="service-pills">
                    <Tag>{`Dashboard ${dashboardService?.status || 'unknown'}`}</Tag>
                    <Tag>{`ML ${mlService?.status || 'unknown'}`}</Tag>
                    <Tag>{`${openReviewCount} open review`}</Tag>
                  </div>
                </div>
              </header>

              {message ? <div className="message-banner">{message}</div> : null}
              {error ? <div className="error-banner">{error}</div> : null}
              <Modal
                show={Boolean(workflowDialog)}
                title={workflowDialog?.title || ''}
                showClose
                closeOnClickBg
                cancel={() => setWorkflowDialog(null)}
                actions={(
                  <div className="actions modal-actions">
                    <Button type="primary" onClick={() => setWorkflowDialog(null)}>
                      {workflowDialog?.confirmLabel || '知道了'}
                    </Button>
                  </div>
                )}
              >
                <div className="modal-copy">
                  <p>{workflowDialog?.body}</p>
                  {workflowDialog?.detail ? <p>{workflowDialog.detail}</p> : null}
                </div>
              </Modal>
              <Modal
                show={Boolean(colorOverwriteDialog)}
                title="确认覆盖 Color 输出"
                width={720}
                showClose
                closeOnClickBg
                cancel={() => setColorOverwriteDialog(null)}
                actions={(
                  <div className="actions modal-actions">
                    <Button type="default" onClick={() => setColorOverwriteDialog(null)}>
                      取消
                    </Button>
                    <Button
                      type="primary"
                      onClick={() => {
                        const dialog = colorOverwriteDialog;
                        setColorOverwriteDialog(null);
                        if (!dialog) return;
                        runProjectWorkflow(dialog.jobType, {
                          ...dialog.args,
                          overwriteConfirmed: true,
                          overwritePlanHash: dialog.preview?.overwritePlanHash,
                        });
                      }}
                    >
                      确认覆盖并导出
                    </Button>
                  </div>
                )}
              >
                <div className="modal-copy">
                  <p>
                    {`将替换 ${colorOverwriteDialog?.preview?.existingCount || 0} 个已有目标，覆盖范围由当前预览 hash 锁定。`}
                  </p>
                  <p>
                    {`输出 root：${colorOverwriteDialog?.preview?.outputRoot || '多个 roots'}`}
                  </p>
                  <p>Resolve 会按 raw 父目录拆临时时间线，直接渲染到最终 root/day 目录。</p>
                  <div className="color-overwrite-preview-list">
                    {(colorOverwriteDialog?.preview?.byDirectory || []).slice(0, 12).map(item => (
                      <div key={item.directory || 'root'} className="color-overwrite-preview-row">
                        <span>{item.directory || '(root)'}</span>
                        <strong>{`${item.existingCount}/${item.clipCount}`}</strong>
                      </div>
                    ))}
                  </div>
                  {(colorOverwriteDialog?.preview?.duplicateStemGroups || []).length > 0 ? (
                    <p>
                      {`检测到 ${colorOverwriteDialog.preview.duplicateStemGroups.length} 组同目录重名 stem；导出会在启动 Resolve 前阻塞，请先处理源文件名。`}
                    </p>
                  ) : null}
                </div>
              </Modal>

              <Switch>
                <Route
                  exact
                  path="/"
                  render={() => (
                    <OverviewPage
                      currentProject={currentProject}
                      activeJobs={activeJobs}
                      services={services}
                      projectProgress={projectProgress}
                      openReviewCount={openReviewCount}
                    />
                  )}
                />
                <Route
                  exact
                  path="/ingest-gps"
                  render={() => (
                    <IngestGpsPage
                      projectId={projectId}
                      config={config}
                      capabilities={capabilities}
                      jobs={allJobs}
                      setProjectBrief={setProjectBrief}
                      setManualItinerary={setManualItinerary}
                      saveSection={saveSection}
                      busy={busy}
                      reviews={reviews}
                      setReviews={setReviews}
                      resolveReview={resolveReview}
                      onRunIngest={() => runProjectWorkflow('ingest')}
                      onRunGpsRefresh={() => runProjectWorkflow('gps-refresh')}
                    />
                  )}
                />
                <Route
                  exact
                  path="/color"
                  render={() => (
                    <ColorPage
                      projectId={projectId}
                      config={config}
                      colorArchive={colorArchive}
                      capabilities={capabilities}
                      jobs={allJobs}
                      setProjectBrief={setProjectBrief}
                      saveSection={saveSection}
                      busy={busy}
                      onRunColorAction={args => runProjectWorkflow('color', args)}
                      onRequestHostPreflight={(payload, options) => recheckColorHost(projectId, payload, options)}
                      onSaveDrpSnapshot={saveColorDrpSnapshot}
                      onRegisterDrpSnapshot={registerColorDrpSnapshot}
                    />
                  )}
                />
                <Route
                  exact
                  path="/analyze/monitor"
                  render={() => <Redirect to="/analyze" />}
                />
                <Route
                  exact
                  path="/analyze"
                  render={() => (
                    <AnalyzePage
                      projectId={projectId}
                      projectProgress={projectProgress}
	                      activeJobs={activeJobs}
	                      capabilities={capabilities}
	                      busy={busy}
	                      onRun={() => runProjectWorkflow('analyze')}
	                    />
	                  )}
                />
                <Route
                  exact
                  path="/chronology"
                  render={() => (
                    <ChronologyPage
                      projectId={projectId}
                      config={config?.chronology}
                      spans={config?.spans}
                      capabilities={capabilities}
                      jobs={activeJobs}
                      busy={busy}
                      onRunSpatialRefresh={() => runProjectWorkflow('spatial-refresh')}
                      onRunSpanRebuild={() => runProjectWorkflow('span-rebuild')}
                      onRunChronologyBuild={() => runProjectWorkflow('chronology-build')}
                      onConfirm={confirmChronology}
                      onSaveEvent={saveChronologyEvent}
                      onMergeEvents={mergeChronologyEvents}
                      onSplitEvent={splitChronologyEvent}
                    />
                  )}
                />
                <Route
                  exact
                  path="/style/monitor/:categoryId?"
                  render={props => <Redirect to={buildStylePath(props.match.params.categoryId)} />}
                />
                <Route
                  exact
                  path="/style"
                  render={routeProps => (
                    <StylePage
                      config={styleSources}
                      capabilities={capabilities}
                      jobs={allJobs}
                      setStyleSources={setStyleSources}
                      onSave={saveStyleLibrary}
                      busy={busy}
                      onRun={categoryId => runWorkspaceWorkflow('style-analysis', categoryId ? { categoryId } : {})}
                      location={routeProps.location}
                      history={routeProps.history}
                    />
                  )}
                />
                <Route
                  exact
                  path="/script"
                  render={() => (
                    <ScriptPage
                      config={config?.scriptBrief}
                      editFlowPlan={config?.editFlowPlan}
                      editRules={editRules}
                      styleSources={styleSources}
                      setScriptBrief={setScriptBrief}
                      saveScriptBriefReview={saveScriptBriefReview}
                      saveScriptBriefEditRuleCategory={saveScriptBriefEditRuleCategory}
                      saveScriptBriefStyleCategory={saveScriptBriefStyleCategory}
                      authorizeScriptBriefRegeneration={authorizeScriptBriefRegeneration}
                      busy={busy}
                      jobs={allJobs}
                      projectId={projectId}
                      onRun={() => runProjectWorkflow('script')}
                      onGenerateFlowPlan={() => runProjectWorkflow('edit-flow-plan', {
                        editId: config?.scriptBrief?.editId || 'main',
                        editRuleCategory: config?.scriptBrief?.editRuleCategory,
                        styleCategory: config?.scriptBrief?.styleCategory,
                      })}
                      onConfirmFlowPlan={confirmFlowPlan}
                      onWorkflowTransition={workflowState => openWorkflowDialog(buildScriptWorkflowDialog(workflowState))}
                    />
                  )}
                />
                <Route
                  exact
                  path="/timeline-export"
                  render={() => (
                    <TimelineExportPage capabilities={capabilities} />
                  )}
                />
                <Route
                  exact
                  path="/project"
                  render={() => (
                    <ProjectPage
                      services={services}
                      busy={busy}
                      onControlMl={controlMlService}
                      reviews={reviews}
                      setReviews={setReviews}
                      resolveReview={resolveReview}
                      currentProject={currentProject}
                    />
                  )}
                />
                <Redirect to="/" />
              </Switch>
            </div>
          </div>
        )}
      />
    </Router>
  );
}

function OverviewPage({ currentProject, activeJobs, services, projectProgress, openReviewCount }) {
  const workflows = [
    { path: '/ingest-gps', label: '导入与 GPS', summary: '维护单真值素材 Root、manual-itinerary 与素材时间校正。' },
    { path: '/color', label: '达芬奇调色', summary: '维护 Root render preset，并执行 prepare / sync groups / execute / validate。' },
    { path: '/analyze', label: '素材分析', summary: '直接查看分析监控、恢复进度并启动 Analyze。' },
    { path: '/chronology', label: '编年史', summary: '审查 Chronology V2 的事件、路线、缺口和确认状态。' },
    { path: '/style', label: '风格分析', summary: '维护 Workspace 风格库、style sources、风格档案和当前分类监控。' },
    { path: '/script', label: '脚本', summary: '维护 script-brief，并准备确定性材料给 Agent 继续写稿。' },
    { path: '/timeline-export', label: '时间线与导出', summary: '查看时间线和导出阶段的能力与 blocker。' },
    { path: '/project', label: '项目', summary: '查看全量 Review Queue 与服务诊断。' },
  ];

  return (
    <div className="route-page">
      <RouteIntro
        title="总览"
        subtitle={`${currentProject?.project?.name || '当前项目'} 的服务状态、最近进度与工作流入口。`}
      />
      <div className="card-grid card-grid-two">
        <Card className="panel">
          <h2>服务摘要</h2>
          <div className="stack-list">
            {services.map(service => (
              <div key={service.name} className="job-item">
                <div>
                  <strong>{service.name}</strong>
                  <div className="muted">{service.url || `${service.port || ''}`}</div>
                </div>
                <Tag>{service.status}</Tag>
              </div>
            ))}
          </div>
        </Card>
        <Card className="panel">
          <h2>最近进度</h2>
          {projectProgress ? (
            <div className="job-item">
              <div>
                <strong>{projectProgress.pipelineLabel || 'media-analyze'}</strong>
                <div className="muted">{projectProgress.stepLabel || projectProgress.step}</div>
              </div>
              <Tag>{projectProgress.status || 'unknown'}</Tag>
              <div className="muted">{`${projectProgress.current || 0}/${projectProgress.total || 0}`}</div>
              {projectProgress.fileName ? <div className="muted">{projectProgress.fileName}</div> : null}
            </div>
          ) : (
            <p className="muted">当前项目暂无运行进度。</p>
          )}
        </Card>
      </div>

      <Card className="panel">
        <div className="section-header">
          <h2>运行中任务</h2>
          <Tag>{`${activeJobs.length} 个`}</Tag>
        </div>
        {activeJobs.length === 0 ? <p className="muted">当前没有活跃 job。</p> : null}
        <div className="stack-list">
          {activeJobs.map(job => (
            <div key={job.jobId} className="job-item">
              <div>
                <strong>{job.jobType}</strong>
                <div className="muted">{job.projectId || 'workspace'}</div>
              </div>
              <Tag>{job.status}</Tag>
              {job.progress?.stepLabel ? <div className="muted">{job.progress.stepLabel}</div> : null}
            </div>
          ))}
        </div>
      </Card>

      <Card className="panel">
        <div className="section-header">
          <h2>工作流入口</h2>
          <Tag>{`${openReviewCount} open review`}</Tag>
        </div>
        <div className="link-card-grid">
          {workflows.map(workflow => (
            <Link key={workflow.path} to={workflow.path} className="link-card">
              <div className="eyebrow">{workflow.path.replace('/', '') || 'home'}</div>
              <strong>{workflow.label}</strong>
              <p>{workflow.summary}</p>
            </Link>
          ))}
        </div>
      </Card>
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
  if (!config) {
    return (
      <div className="route-page">
        <EmptyPanel label="当前项目配置尚未加载完成。" />
      </div>
    );
  }
  return (
    <div className="route-page">
      <RouteIntro title="导入与 GPS" subtitle="维护单真值素材 Root、行程正文、结构化 segment 与拍摄时间校正。" />
      <IngestGpsActionPanel
        projectId={projectId}
        capabilities={capabilities}
        jobs={jobs}
        busy={busy}
        onRunIngest={onRunIngest}
        onRunGpsRefresh={onRunGpsRefresh}
      />
      <ProjectBriefEditor
        config={config.projectBrief}
        pharosStatus={config.pharosStatus}
        summaries={config.ingestRootSummaries || []}
        setConfig={setProjectBrief}
        onSave={() => saveSection('project-brief')}
        busy={busy['project-brief']}
      />
      <ManualItineraryEditor
        config={config.manualItinerary}
        setConfig={setManualItinerary}
        onSave={() => saveSection('manual-itinerary')}
        busy={busy['manual-itinerary']}
      />
      <IngestRootClockEditor
        config={config.projectBrief}
        summaries={config.ingestRootSummaries || []}
        setConfig={setProjectBrief}
        onSave={() => saveSection('project-brief')}
        busy={busy['project-brief']}
      />
      <CaptureTimeOverridesEditor
        config={config.manualItinerary}
        setConfig={setManualItinerary}
        onSave={() => saveSection('manual-itinerary')}
        busy={busy['manual-itinerary']}
      />
      <ReviewQueuePanel
        reviews={reviews}
        setReviews={setReviews}
        onResolve={resolveReview}
        title="导入 / GPS Review"
        emptyLabel="当前没有 ingest / gps 相关 review。"
        filter={review => review.kind !== 'capture-time-correction' && ['project-init', 'ingest', 'gps-refresh'].includes(review.stage)}
      />
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
    <Card className="panel">
      <div className="section-header">
        <h2>导入与 GPS 刷新</h2>
        <Tag>{latestJob ? formatIngestGpsJobStatus(latestJob.status) : '未运行'}</Tag>
      </div>
      <p className="muted">保存配置只落盘；需要更新资产、同源 GPS、derived track 或 chronology 时，在这里显式运行。</p>
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
      <div className="stack-list">
        {latestJob ? (
          <div className="job-item">
            <div>
              <strong>{describeIngestGpsJobTitle(latestJob)}</strong>
              <div className="muted">{describeIngestGpsJob(latestJob)}</div>
              {latestJob.resultPath ? <div className="muted">{`结果：${latestJob.resultPath}`}</div> : null}
            </div>
            <Tag>{formatIngestGpsJobStatus(latestJob.status)}</Tag>
          </div>
        ) : (
          <div className="job-item">
            <div>
              <strong>尚未运行</strong>
              <div className="muted">修改素材 Root、FlightRecord、时间校正或行程后，先运行 Ingest 再进入 Analyze。</div>
            </div>
            <Tag>idle</Tag>
          </div>
        )}
        {latestJob?.blockers?.length ? (
          <div className="pipeline-footnote">
            {`Blockers：${latestJob.blockers.join('；')}`}
          </div>
        ) : null}
        <div className="pipeline-footnote">
          {`活跃 ingest ${activeIngestJobs.length} · 活跃 gps-refresh ${activeGpsRefreshJobs.length}`}
        </div>
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
        subtitle="这里优先读取 `config.colorRoots` 这个 root 级 read model；页面按 `Root 摘要 -> 当前 Root Hero -> 所有 Root 常驻可编辑配置 -> Groups -> 次级诊断/归档` 组织。"
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
        <WorkflowPrompt
          eyebrow="Current Scope"
          title="当前 color 已支持 vendored Resolve backend 闭环入口"
          body="现在可以在 `/color` 同页维护所有 Root 的 render preset，并按 `Prepare Root -> Sync Groups -> Execute -> Validate` 触发单 root 闭环，或按 `Prepare All Roots / Export All Roots` 触发项目级顺序批处理。"
          tone="accent"
          detail={colorCapabilityDetail}
        />
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
	            type={canStartAnalyze ? 'primary' : 'disabled'}
	            disabled={!canStartAnalyze}
	            onClick={onRun}
	          >
	            {busy['job:analyze'] ? '启动中…' : analyzeJobs.length > 0 ? 'Analyze 运行中…' : '启动 Analyze'}
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

  return (
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
  );
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

function ChronologyProgressPanel({ jobs }) {
  const latestJob = [...(jobs || [])].sort(compareActiveProjectJobs)[0] || null;
  if (!latestJob) return null;
  const progress = latestJob.progress || null;
  const percent = resolveProgressPercent(progress);
  const extra = progress?.extra || {};
  const blockers = latestJob.blockers || [];
  const etaLabel = formatEtaSeconds(progress?.etaSeconds);
  const captionLeft = progress
    ? `${progress.current || 0}/${progress.total || 0} ${progress.unit || 'step'}`
    : blockers.join('；') || latestJob.lastError || '等待任务写入进度';
  const chunkLabel = progress?.fileTotal ? `chunk ${progress.fileIndex || 0}/${progress.fileTotal}` : '';
  const captionRight = [chunkLabel, etaLabel ? `剩余 ${etaLabel}` : null].filter(Boolean).join(' · ')
    || latestJob.updatedAt
    || '';
  const isBlockedWithoutProgress = latestJob.status === 'blocked' && !progress;

  return (
    <div className="chronology-progress">
      <div className="chronology-progress-top">
        <div>
          <strong>{describeChronologyJobTitle(latestJob)}</strong>
          <div className="muted">{progress?.detail || progress?.stepLabel || blockers.join('；') || latestJob.lastError || latestJob.jobId}</div>
        </div>
        <Tag>{latestJob.status}</Tag>
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
      {isBlockedWithoutProgress ? (
        <div className="pipeline-footnote">
          当前没有写入新的 spans；请确认本地 qwen 文本 LM / ML 服务可用后重新运行。
        </div>
      ) : (
        <div className="pipeline-metric-grid chronology-progress-metrics">
          <PipelineMetricCard label="阶段" value={progress?.stepLabel || progress?.step || latestJob.status} sub={progress?.phaseLabel || latestJob.executionMode} />
          <PipelineMetricCard label="素材片段" value={String(extra.spanCount ?? 0)} sub={extra.inputsHash ? `input ${String(extra.inputsHash).slice(0, 12)}` : 'span rebuild 输出'} />
          <PipelineMetricCard label="重试" value={String(extra.retryCount ?? 0)} sub={`warnings ${extra.warningCount ?? blockers.length ?? 0}`} />
          <PipelineMetricCard label="失败列表" value={String(extra.failedCount ?? 0)} sub={`恢复 ${extra.recoveredFailedCount ?? 0} · 情景不明 ${extra.storyUnknownFallbackCount ?? 0}`} />
          <PipelineMetricCard label="剩余时间" value={etaLabel || '估算中'} sub={progress?.status === 'succeeded' ? '已完成' : '按当前 span 处理速度估算'} />
        </div>
      )}
    </div>
  );
}

function ChronologyPage({
  projectId,
  config,
  spans,
  capabilities,
  jobs,
  busy,
  onRunSpatialRefresh,
  onRunSpanRebuild,
  onRunChronologyBuild,
  onConfirm,
  onSaveEvent,
  onMergeEvents,
  onSplitEvent,
}) {
  const chronology = config?.chronology || null;
  const events = chronology?.events || [];
  const chronologyJobs = (jobs || []).filter(job =>
    job.projectId === projectId && ['spatial-refresh', 'span-rebuild', 'chronology-build'].includes(job.jobType));
  const activeChronologyJobs = chronologyJobs.filter(isLiveSupervisorJob);
  const blockedChronologyJobs = chronologyJobs.filter(job => job.status === 'blocked');
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
  const hasFreshSpans = Boolean(spans?.fresh);
  const canStartChronologyBuild = Boolean(projectId)
    && hasFreshSpans
    && !busy['job:chronology-build']
    && activeChronologyJobs.length === 0
    && chronologyBuildCapability?.supported !== false;
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dayFilter, setDayFilter] = useState('all');
  const [selected, setSelected] = useState({});
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    setSelected({});
    setDrafts({});
  }, [chronology?.inputsHash, chronology?.updatedAt]);

  const days = useMemo(() => dedupeUiStrings(events
    .map(event => resolveChronologyDay(event))
    .filter(Boolean)), [events]);
  const filteredEvents = events.filter(event => {
    if (kindFilter !== 'all' && event.kind !== kindFilter) return false;
    if (statusFilter !== 'all' && event.reviewStatus !== statusFilter) return false;
    if (dayFilter !== 'all' && resolveChronologyDay(event) !== dayFilter) return false;
    return true;
  });
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
    onSaveEvent(event.id, {
      kind: draft.kind,
      reviewStatus: draft.reviewStatus,
      title: draft.title,
      summary: draft.summary,
      startAt: draft.startAt,
      endAt: draft.endAt,
      location: draft.location,
      route: draft.route,
    });
  }

  return (
    <div className="route-page">
      <RouteIntro
        title="编年史"
        subtitle="审查项目级 Chronology V2：事件、路线、缺口、时间地点、确认状态和关联 span。"
      />
      <Card className="panel">
        <div className="section-header">
          <h2>生成链路</h2>
          <Tag>{`spans ${spans?.status || 'missing'} · ${spans?.count || 0}`}</Tag>
        </div>
        <div className="chronology-toolbar">
          <div className="monitor-toolbar-group">
            <Button
              type={canStartSpanRebuild ? 'primary' : 'disabled'}
              disabled={!canStartSpanRebuild}
              onClick={onRunSpanRebuild}
            >
              {busy['job:span-rebuild'] || spanRebuildJobs.length > 0 ? '生成中…' : '生成素材片段与模式'}
            </Button>
            <Button
              type={canStartChronologyBuild ? 'primary' : 'disabled'}
              disabled={!canStartChronologyBuild}
              onClick={onRunChronologyBuild}
            >
              {busy['job:chronology-build'] || chronologyBuildJobs.length > 0 ? '刷新中…' : '生成/刷新编年史'}
            </Button>
            <Button
              type={canStartSpatialRefresh ? 'default' : 'disabled'}
              disabled={!canStartSpatialRefresh}
              onClick={onRunSpatialRefresh}
            >
              {busy['job:spatial-refresh'] || spatialRefreshJobs.length > 0 ? '刷新中…' : '刷新时空真相'}
            </Button>
          </div>
          <div className="monitor-toolbar-meta">
            <span>{activeChronologyJobs.length > 0 ? `${activeChronologyJobs.length} 个任务运行中` : '当前无 chronology 任务'}</span>
            {blockedChronologyJobs.length > 0 ? <span>{`${blockedChronologyJobs.length} 个任务已阻塞`}</span> : null}
            {spans?.meta?.inputsHash ? <span>{`spans input ${spans.meta.inputsHash.slice(0, 12)}`}</span> : null}
          </div>
        </div>
        <ChronologyProgressPanel jobs={chronologyJobs} />
        {spans?.meta?.warnings?.length ? (
          <div className="pipeline-footnote">
            {`${activeChronologyJobs.length > 0 || blockedChronologyJobs.length > 0 ? '上次 spans warning：' : ''}${spans.meta.warnings.slice(0, 3).join('；')}`}
          </div>
        ) : null}
      </Card>
      {config?.blocked ? (
        <WorkflowPrompt
          eyebrow="Blocked"
          title="Chronology 需要重建"
          body={config.message || '当前 chronology 不可用。先刷新空间结果或重新 Analyze，再回到这里确认。'}
          tone="error"
        />
      ) : null}
      <Card className="panel">
        <div className="section-header">
          <h2>Chronology V2</h2>
          <Tag>{chronology ? `${chronology.status} · ${events.length} events` : 'missing'}</Tag>
        </div>
        <div className="chronology-toolbar">
          <div className="monitor-toolbar-group">
            <select value={dayFilter} onChange={event => setDayFilter(event.target.value)}>
              <option value="all">全部日期</option>
              {days.map(day => <option key={day} value={day}>{day}</option>)}
            </select>
            <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
              <option value="all">全部类型</option>
              <option value="event">event</option>
              <option value="route">route</option>
              <option value="gap">gap</option>
            </select>
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="all">全部状态</option>
              <option value="pending">pending</option>
              <option value="confirmed">confirmed</option>
              <option value="rejected">rejected</option>
            </select>
          </div>
          <div className="actions">
            <Button
              type={selectedEventIds.length >= 2 && !busy['chronology:merge'] ? 'default' : 'disabled'}
              disabled={selectedEventIds.length < 2 || busy['chronology:merge']}
              onClick={() => onMergeEvents(selectedEventIds)}
            >
              合并
            </Button>
            <Button
              type={chronology && !busy['chronology:confirm'] ? 'primary' : 'disabled'}
              disabled={!chronology || busy['chronology:confirm']}
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
      <div className="chronology-shot-list">
        {filteredEvents.length === 0 ? (
          <EmptyPanel label="当前过滤条件下没有 chronology event。" />
        ) : filteredEvents.map(event => {
          const draft = drafts[event.id] || event;
          return (
            <Card key={event.id} className="chronology-row">
              <div className="chronology-row-select">
                <input
                  type="checkbox"
                  checked={Boolean(selected[event.id])}
                  onChange={changeEvent => setSelected(current => ({
                    ...current,
                    [event.id]: changeEvent.target.checked,
                  }))}
                />
              </div>
              <div className="chronology-row-main">
                <div className="chronology-row-meta">
                  <Tag>{draft.kind}</Tag>
                  <Tag>{draft.reviewStatus}</Tag>
                  <span>{formatChronologyTimeRange(draft)}</span>
                  <span>{draft.spanIds?.length || 0} spans</span>
                </div>
                <input
                  className="chronology-title-input"
                  value={draft.title || ''}
                  onChange={changeEvent => updateDraft(event, { title: changeEvent.target.value })}
                />
                <textarea
                  value={draft.summary || ''}
                  onChange={changeEvent => updateDraft(event, { summary: changeEvent.target.value })}
                  rows={2}
                />
                <div className="chronology-row-fields">
                  <input
                    value={draft.startAt || ''}
                    onChange={changeEvent => updateDraft(event, { startAt: changeEvent.target.value })}
                    placeholder="startAt"
                  />
                  <input
                    value={draft.endAt || ''}
                    onChange={changeEvent => updateDraft(event, { endAt: changeEvent.target.value })}
                    placeholder="endAt"
                  />
                  <input
                    value={draft.location || ''}
                    onChange={changeEvent => updateDraft(event, { location: changeEvent.target.value })}
                    placeholder="location"
                  />
                  <input
                    value={draft.route?.from || ''}
                    onChange={changeEvent => updateDraft(event, { route: { ...(draft.route || {}), from: changeEvent.target.value } })}
                    placeholder="from"
                  />
                  <input
                    value={draft.route?.to || ''}
                    onChange={changeEvent => updateDraft(event, { route: { ...(draft.route || {}), to: changeEvent.target.value } })}
                    placeholder="to"
                  />
                </div>
              </div>
              <div className="chronology-row-actions">
                <select value={draft.kind} onChange={changeEvent => updateDraft(event, { kind: changeEvent.target.value })}>
                  <option value="event">event</option>
                  <option value="route">route</option>
                  <option value="gap">gap</option>
                </select>
                <select value={draft.reviewStatus} onChange={changeEvent => updateDraft(event, { reviewStatus: changeEvent.target.value })}>
                  <option value="pending">pending</option>
                  <option value="confirmed">confirmed</option>
                  <option value="rejected">rejected</option>
                </select>
                <Button
                  type={busy[`chronology:event:${event.id}`] ? 'disabled' : 'default'}
                  disabled={busy[`chronology:event:${event.id}`]}
                  onClick={() => saveDraft(event)}
                >
                  保存
                </Button>
                <Button
                  type="default"
                  onClick={() => onSaveEvent(event.id, { reviewStatus: 'confirmed' })}
                >
                  确认
                </Button>
                <Button
                  type="default"
                  onClick={() => onSaveEvent(event.id, { reviewStatus: 'rejected' })}
                >
                  驳回
                </Button>
                <Button
                  type={(event.spanIds?.length || 0) > 1 && !busy[`chronology:split:${event.id}`] ? 'default' : 'disabled'}
                  disabled={(event.spanIds?.length || 0) <= 1 || busy[`chronology:split:${event.id}`]}
                  onClick={() => onSplitEvent(event.id)}
                >
                  拆分
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function resolveChronologyDay(event) {
  const value = event.startAt || event.endAt || '';
  return value.slice(0, 10);
}

function formatChronologyTimeRange(event) {
  const start = formatChronologyTime(event.startAt);
  const end = formatChronologyTime(event.endAt);
  if (start && end && start !== end) return `${start} - ${end}`;
  return start || end || '未定时间';
}

function formatChronologyTime(value) {
  if (!value) return '';
  return value.replace('T', ' ').replace('.000Z', 'Z').slice(0, 19);
}

function dedupeUiStrings(values) {
  return Array.from(new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0)));
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
  onGenerateFlowPlan,
  onConfirmFlowPlan,
  onWorkflowTransition,
}) {
  const scriptJobs = (jobs || [])
    .filter(job => job.jobType === 'script'
      && job.executionMode === 'deterministic'
      && (!projectId || job.projectId === projectId));
  const latestJob = scriptJobs[0] || null;
  const activeScriptJobs = scriptJobs.filter(job => ['queued', 'running', 'blocked'].includes(job.status));
  const availableRuleCategories = editRules?.categories || [];
  const availableStyleCategories = styleSources?.categories || [];
  const workflowState = config?.workflowState || 'choose_style';
  const hasSelectedEditRuleCategory = Boolean(config?.editRuleCategory);
  const hasValidEditRuleCategory = hasSelectedEditRuleCategory
    && availableRuleCategories.some(category => category.categoryId === config?.editRuleCategory);
  const hasValidStyleCategory = !config?.styleCategory
    || availableStyleCategories.some(category => category.categoryId === config?.styleCategory);
  const canPrepare = hasValidEditRuleCategory && workflowState === 'ready_to_prepare';
  const flowPlanMatchesRule = Boolean(
    editFlowPlan
    && editFlowPlan.editRuleCategory === config?.editRuleCategory
    && availableRuleCategories.find(category => category.categoryId === config?.editRuleCategory)?.contentHash === editFlowPlan.editRuleHash,
  );
  const hasConfirmedFlowPlan = Boolean(flowPlanMatchesRule && editFlowPlan?.status === 'confirmed');
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
        <p className="muted">这里不会后台自动写稿。先生成并确认 Flow Plan；之后点击准备只会校验剪辑规则、Flow Plan 与素材前置条件，刷新 edit-unit facts 和 shared bundle，并把流程推进到“回到 Agent 继续写正式脚本”。</p>
        {!availableRuleCategories.length ? (
          <p className="muted">Workspace 剪辑规则库当前没有可选分类；请先补 `config/edit-rules/*.md`。</p>
        ) : null}
        {hasValidEditRuleCategory ? (
          <div className="job-item">
            <div>
              <strong>Flow Plan</strong>
              <div className="muted">
                {editFlowPlan
                  ? `${editFlowPlan.status}${flowPlanMatchesRule ? '' : ' / stale'} · ${editFlowPlan.steps?.length || 0} steps`
                  : '尚未生成'}
              </div>
            </div>
            <Tag>{hasConfirmedFlowPlan ? 'confirmed' : flowPlanMatchesRule ? editFlowPlan.status : 'required'}</Tag>
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
              type={busy['job:edit-flow-plan'] || !hasValidEditRuleCategory ? 'disabled' : 'default'}
              disabled={busy['job:edit-flow-plan'] || !hasValidEditRuleCategory}
              onClick={onGenerateFlowPlan}
            >
              {busy['job:edit-flow-plan'] ? '生成中…' : '生成 Flow Plan'}
            </Button>
            <Button
              type={busy['edit-flow:confirm'] || !flowPlanMatchesRule || editFlowPlan?.status === 'confirmed' ? 'disabled' : 'default'}
              disabled={busy['edit-flow:confirm'] || !flowPlanMatchesRule || editFlowPlan?.status === 'confirmed'}
              onClick={onConfirmFlowPlan}
            >
              {busy['edit-flow:confirm'] ? '确认中…' : '确认 Flow Plan'}
            </Button>
            <Button
              type={busy['job:script'] || !canPrepare || !hasConfirmedFlowPlan ? 'disabled' : 'primary'}
              disabled={busy['job:script'] || !canPrepare || !hasConfirmedFlowPlan}
              onClick={onRun}
            >
              {busy['job:script'] ? '准备中…' : '准备给 Agent'}
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
  return (
    <div className="route-page">
      <RouteIntro title="时间线与导出" subtitle="这一页先聚合能力和 blocker，不在这轮里扩展新的业务实现。" />
      <Card className="panel">
        <h2>当前能力</h2>
        <div className="stack-list">
          {jobs.filter(job => ['timeline', 'export-jianying', 'export-resolve'].includes(job.jobType)).map(job => (
            <div key={job.jobType} className="job-item">
              <div>
                <strong>{job.jobType}</strong>
                <div className="muted">{job.executionMode}</div>
              </div>
              <Tag>{job.supported ? 'supported' : 'blocked'}</Tag>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function ProjectPage({ services, busy, onControlMl, reviews, setReviews, resolveReview, currentProject }) {
  return (
    <div className="route-page">
      <RouteIntro title="项目" subtitle="查看全量 Review Queue、Supervisor 服务状态与项目级诊断信息。" />
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
      <ReviewQueuePanel
        reviews={reviews}
        setReviews={setReviews}
        onResolve={resolveReview}
        title="Review Queue"
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

  return (
    <div className="route-page">
      {error ? <div className="error-banner">{error}</div> : null}
      <MonitorPage
        model={model}
        emptyLabel={emptyLabel}
        toolbar={typeof toolbar === 'function' ? toolbar(model) : toolbar}
        afterMonitor={typeof afterMonitor === 'function' ? afterMonitor(model) : afterMonitor}
      />
    </div>
  );
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

function pickConsoleProjectId(projects, jobs, storedProjectId) {
  if (!projects.length) {
    return '';
  }
  const activeProjectId = pickLatestActiveProjectId(projects, jobs);
  if (activeProjectId) {
    return activeProjectId;
  }
  if (storedProjectId && projects.some(project => project.projectId === storedProjectId)) {
    return storedProjectId;
  }
  return projects[0]?.projectId || '';
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
  if (job.jobType === 'span-rebuild') return '生成素材片段与素材模式';
  if (job.jobType === 'chronology-build') return '生成/刷新编年史';
  if (job.jobType === 'spatial-refresh') return '刷新时空真相';
  return job.jobType;
}

function isLiveSupervisorJob(job) {
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
    return '确定性脚本准备已完成。请回到 Agent 对话继续生成当前 edit unit 的 segment-plan、material-slots 和 script/current。';
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
      body: '在下面选择一个 workspace 剪辑规则。系统会自动保存，然后下一步是生成并确认 Flow Plan。',
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
      title: '回到 Agent 继续生成正式脚本',
      body: 'deterministic prep 已完成。现在请回到 Agent，对它说“继续”，再让它生成当前 edit unit 的正式 segment-plan、material-slots 和 script/current。',
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

function TopNav({ history, location }) {
  const items = [
    { path: '/', label: '总览' },
    { path: '/ingest-gps', label: '导入与 GPS' },
    { path: '/color', label: '达芬奇调色' },
    { path: '/analyze', label: '素材分析' },
    { path: '/chronology', label: '编年史' },
    { path: '/style', label: '风格分析' },
    { path: '/script', label: '脚本' },
    { path: '/timeline-export', label: '时间线与导出' },
    { path: '/project', label: '项目' },
  ];
  const activePath = resolveTopLevelPath(location.pathname);
  return (
    <div className="top-nav-wrap">
      <Menu
        horizonal
        type="linear"
        className="top-nav"
        value={activePath}
        onClick={(_, value) => history.push(value)}
      >
        {items.map(item => (
          <MenuItem key={item.path} value={item.path}>
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
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
  if (pathname.startsWith('/script')) return '/script';
  if (pathname.startsWith('/timeline-export')) return '/timeline-export';
  if (pathname.startsWith('/project')) return '/project';
  return '/';
}

function resolveCurrentStyleCategory(config, search, jobs = []) {
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
  ready_for_agent: '事实刷新与 bundle 索引已完成，请回到 Agent 继续生成 segment-plan、material-slots 与 script/current.json。',
  script_generated: '脚本已生成，可继续审稿或进入 Timeline。',
};

ReactDOM.render(<AppShell />, document.getElementById('root'));
