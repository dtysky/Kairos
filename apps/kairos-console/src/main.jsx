import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { BrowserRouter as Router, Link, Redirect, Route, Switch } from 'react-router-dom';
import { Button, Card, Menu, MenuItem, Modal, Tag } from 'hana-ui';
import 'hana-ui/hana-style.scss';
import './app.scss';
import {
  controlMl,
  fetchAnalyzeMonitor,
  fetchCapabilities,
  fetchProjectConfig,
  fetchProjectProgress,
  fetchProjectReviews,
  fetchStyleMonitor,
  fetchWorkspaceStyleConfig,
  fetchWorkspaceStatus,
  resolveProjectReview,
  saveProjectSection,
  saveWorkspaceStyleConfig,
  startJob,
  startWorkspaceJob,
} from './api.js';
import { EmptyPanel, MonitorPage } from './monitor-page.jsx';
import {
  CaptureTimeOverridesEditor,
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
  const [projectId, setProjectId] = useState(window.localStorage.getItem('kairos.console.projectId') || '');
  const [config, setConfig] = useState(null);
  const [savedConfig, setSavedConfig] = useState(null);
  const [styleSources, setStyleSources] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [projectProgress, setProjectProgress] = useState(null);
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [workflowDialog, setWorkflowDialog] = useState(null);

  useEffect(() => {
    refreshStatus();
    refreshStyleSources();
    fetchCapabilities().then(setCapabilities).catch(handleError);
    const timer = window.setInterval(refreshStatus, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!status?.projects?.length) return;
    if (projectId && status.projects.some(project => project.projectId === projectId)) {
      return;
    }
    const nextProjectId = status.projects[0].projectId;
    setProjectId(nextProjectId);
  }, [status, projectId]);

  useEffect(() => {
    if (!projectId) return;
    window.localStorage.setItem('kairos.console.projectId', projectId);
    refreshProject(projectId);
    refreshProjectProgress(projectId);
    const timer = window.setInterval(() => refreshProjectProgress(projectId), 4000);
    return () => window.clearInterval(timer);
  }, [projectId]);

  const projects = status?.projects || [];
  const currentProject = projects.find(project => project.projectId === projectId) || null;
  const services = status?.services || [];
  const allJobs = status?.jobs || [];
  const activeJobs = useMemo(
    () => allJobs.filter(job => ['queued', 'running', 'blocked'].includes(job.status))
      .filter(job => !(job.jobType === 'script' && job.executionMode === 'agent')),
    [allJobs],
  );
  const mlService = services.find(service => service.name === 'ml') || null;
  const dashboardService = services.find(service => service.name === 'dashboard') || null;
  const openReviewCount = reviews.filter(review => review.status === 'open').length;

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
      const [nextConfig, nextReviews] = await Promise.all([
        fetchProjectConfig(nextProjectId),
        fetchProjectReviews(nextProjectId),
      ]);
      setConfig(nextConfig);
      setSavedConfig(nextConfig);
      setReviews(nextReviews.items || []);
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshStyleSources() {
    try {
      setStyleSources(await fetchWorkspaceStyleConfig());
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
          : '当前仍在等待 Agent 初版 brief',
      },
    );
  }

  async function saveScriptBriefStyleCategory(styleCategory) {
    const base = savedConfig?.scriptBrief || config?.scriptBrief;
    if (!base) return;
    await saveScriptBriefPayload(
      buildStyleSelectionScriptBriefPayload(base, styleCategory),
      'script-brief:style',
      {
        workflowDialog: styleCategory ? buildScriptWorkflowDialog('await_brief_draft') : null,
        successMessage: styleCategory ? '' : '已清除风格分类',
      },
    );
  }

  async function authorizeScriptBriefRegeneration() {
    const base = savedConfig?.scriptBrief || config?.scriptBrief;
    if (!base?.styleCategory) return;
    await saveScriptBriefPayload(
      buildRegenerateScriptBriefPayload(base),
      'script-brief:regenerate',
      {
        workflowDialog: {
          title: '已授权重新生成初版 brief',
          body: '下一步请回到 Agent，让它重新生成初版 brief。',
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
      await startJob(projectId, jobType, args);
      await refreshStatus();
      setMessage(jobType === 'script' ? '' : `已启动 ${jobType}`);
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
                  <p>工作流优先的配置、监控与任务控制台。</p>
                </div>
                <div className="workspace-actions">
                  <select value={projectId} onChange={event => setProjectId(event.target.value)}>
                    {projects.map(project => (
                      <option key={project.projectId} value={project.projectId}>{project.project.name}</option>
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
                      config={config}
                      setProjectBrief={setProjectBrief}
                      setManualItinerary={setManualItinerary}
                      saveSection={saveSection}
                      busy={busy}
                      reviews={reviews}
                      setReviews={setReviews}
                      resolveReview={resolveReview}
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
                      busy={busy}
                      onRun={() => runProjectWorkflow('analyze')}
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
                      styleSources={styleSources}
                      setScriptBrief={setScriptBrief}
                      saveScriptBriefReview={saveScriptBriefReview}
                      saveScriptBriefStyleCategory={saveScriptBriefStyleCategory}
                      authorizeScriptBriefRegeneration={authorizeScriptBriefRegeneration}
                      busy={busy}
                      jobs={allJobs}
                      projectId={projectId}
                      onRun={() => runProjectWorkflow('script')}
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
    { path: '/ingest-gps', label: '导入与 GPS', summary: '维护 project-brief、manual-itinerary 与素材时间校正。' },
    { path: '/analyze', label: '素材分析', summary: '直接查看分析监控、恢复进度并启动 Analyze。' },
    { path: '/style', label: '风格分析', summary: '维护 Workspace 风格库、style sources，并查看当前分类监控。' },
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
  config,
  setProjectBrief,
  setManualItinerary,
  saveSection,
  busy,
  reviews,
  setReviews,
  resolveReview,
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
      <RouteIntro title="导入与 GPS" subtitle="维护项目素材根、行程正文、结构化 segment 与拍摄时间校正。" />
      <ProjectBriefEditor
        config={config.projectBrief}
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
        filter={review => ['project-init', 'ingest', 'gps-refresh'].includes(review.stage)}
      />
    </div>
  );
}

function AnalyzePage({ projectId, projectProgress, activeJobs, busy, onRun }) {
  const analyzeJobs = activeJobs.filter(job => job.jobType === 'analyze');
  return (
    <MonitorLoader
      kind="analyze"
      projectId={projectId}
      emptyLabel="当前项目还没有可展示的 Analyze 监控数据。"
      toolbar={model => (
        <>
          <div className="monitor-toolbar-group">
          <Button
            type={busy['job:analyze'] || !projectId ? 'disabled' : 'primary'}
            disabled={busy['job:analyze'] || !projectId}
            onClick={onRun}
          >
            {busy['job:analyze'] ? '启动中…' : '启动 Analyze'}
          </Button>
          </div>
          <div className="monitor-toolbar-meta">
            <span>{`活跃 job ${analyzeJobs.length}`}</span>
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
                <strong>{job.jobId.slice(0, 8)}</strong>
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

function StylePage({ config, setStyleSources, onSave, busy, onRun, location, history }) {
  if (!config) {
    return (
      <div className="route-page">
        <EmptyPanel label="风格来源配置尚未加载完成。" />
      </div>
    );
  }
  const currentCategoryId = resolveCurrentStyleCategory(config, location.search);
  return (
    <MonitorLoader
      kind="style"
      categoryId={currentCategoryId}
      emptyLabel="当前分类还没有可展示的风格分析监控数据。"
      toolbar={(
        <>
          <div className="monitor-toolbar-group">
            <select
              value={currentCategoryId}
              onChange={event => history.push(buildStylePath(event.target.value))}
            >
              {config.categories.map(category => (
                <option key={category.categoryId} value={category.categoryId}>{category.displayName}</option>
              ))}
            </select>
          <Button
            type={busy['job:style-analysis'] || !currentCategoryId ? 'disabled' : 'primary'}
            disabled={busy['job:style-analysis'] || !currentCategoryId}
            onClick={() => onRun(currentCategoryId)}
          >
            {busy['job:style-analysis'] ? '启动中…' : '启动 Style Analysis'}
          </Button>
          </div>
          <div className="monitor-toolbar-meta">
            <span>{`${config.categories.length} 个分类`}</span>
            {currentCategoryId ? <span>{currentCategoryId}</span> : null}
          </div>
        </>
      )}
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
  styleSources,
  setScriptBrief,
  saveScriptBriefReview,
  saveScriptBriefStyleCategory,
  authorizeScriptBriefRegeneration,
  busy,
  jobs,
  projectId,
  onRun,
  onWorkflowTransition,
}) {
  const scriptJobs = (jobs || [])
    .filter(job => job.jobType === 'script'
      && job.executionMode === 'deterministic'
      && (!projectId || job.projectId === projectId));
  const latestJob = scriptJobs[0] || null;
  const activeScriptJobs = scriptJobs.filter(job => ['queued', 'running', 'blocked'].includes(job.status));
  const availableCategories = styleSources?.categories || [];
  const workflowState = config?.workflowState || 'choose_style';
  const hasSelectedStyleCategory = Boolean(config?.styleCategory);
  const hasValidStyleCategory = hasSelectedStyleCategory
    && availableCategories.some(category => category.categoryId === config?.styleCategory);
  const canPrepare = hasValidStyleCategory && workflowState === 'ready_to_prepare';
  const workflowPrompt = buildScriptWorkflowPrompt({
    config,
    availableCategories,
    hasSelectedStyleCategory,
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
        subtitle="先在这里选风格并审查 brief，再点“准备给 Agent”；最终 `script/current.json` 仍由 Agent 生成。"
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
        <p className="muted">这里不会后台自动写稿。点击后只会校验风格与素材前置条件，生成 `script/arrangement.current.json`、`script/arrangement-skeletons.json` 与 `script/segment-cards.json`，并把流程推进到“回到 Agent 继续写正式脚本”。</p>
        {!availableCategories.length ? (
          <p className="muted">Workspace 风格库当前没有可选分类；请先到 `/style` 配置或生成风格档案。</p>
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
              type={busy['job:script'] || !canPrepare ? 'disabled' : 'primary'}
              disabled={busy['job:script'] || !canPrepare}
              onClick={onRun}
            >
              {busy['job:script'] ? '准备中…' : '准备给 Agent'}
            </Button>
        </div>
        <div className="muted">{`活跃 job ${activeScriptJobs.length}`}</div>
      </Card>
      <ScriptBriefEditor
        config={config}
        styleSources={styleSources}
        setConfig={setScriptBrief}
        onSave={saveScriptBriefReview}
        onStyleCategoryChange={saveScriptBriefStyleCategory}
        onRequestRegenerate={authorizeScriptBriefRegeneration}
        busy={busy['script-brief']}
        autoSaveBusy={busy['script-brief:style']}
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
    return '确定性脚本准备已完成。请回到 Agent 对话继续生成 `script/current.json`。';
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
  hasSelectedStyleCategory,
  hasValidStyleCategory,
  workflowState,
  latestJob,
}) {
  if (!availableCategories.length) {
    return {
      eyebrow: 'Action Required',
      title: '先去 /style 准备风格库',
      body: '当前 workspace 还没有任何可选风格分类。先去 /style 配置或生成风格档案，再回到这里继续脚本流程。',
      tone: 'warn',
    };
  }
  if (!hasSelectedStyleCategory) {
    return {
      eyebrow: 'Action Required',
      title: '先选择风格分类',
      body: '在下面选择一个 workspace 风格分类。系统会自动保存，然后下一步就是回到 Agent 生成初版 brief。',
      tone: 'warn',
    };
  }
  if (config?.styleCategory && !hasValidStyleCategory) {
    return {
      eyebrow: 'Blocked',
      title: '当前风格分类已失效',
      body: '这个项目记录的风格分类在 workspace 风格库里已经不存在了。先在下面重新选择一个有效分类，再继续脚本准备。',
      tone: 'error',
    };
  }
  if (workflowState === 'await_brief_draft') {
    return {
      eyebrow: 'Next Step',
      title: '回到 Agent 生成初版 brief',
      body: '风格分类已经保存。下一步不在这里，而是在 Agent 对话里让它起草第一版 script-brief。',
      tone: 'accent',
    };
  }
  if (workflowState === 'review_brief') {
    return {
      eyebrow: 'Next Step',
      title: '先审查并保存 brief',
      body: 'Agent 初版已经生成。请在当前页面修改并保存；保存后，流程才会进入“准备给 Agent”。',
      detail: '如果你决定重生初版 brief，也请先在这里通过覆盖确认。',
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
      body: 'deterministic prep 已完成。现在请回到 Agent，对它说“继续”，再让它写正式的 `script/current.json`。',
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
    title: '先选择风格分类',
    body: '在下面完成风格选择后，系统才知道下一步该把你带去哪个脚本流程状态。',
    tone: 'warn',
  };
}

function buildScriptWorkflowDialog(workflowState) {
  if (workflowState === 'await_brief_draft') {
    return {
      title: '风格已保存',
      body: '下一步请回到 Agent，生成初版 brief。',
      detail: '这个 handoff 已经同步到当前页面顶部的 workflow prompt，不用担心关掉弹窗后找不到下一步。',
    };
  }
  if (workflowState === 'review_brief') {
    return {
      title: '初版 brief 已生成',
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
    { path: '/analyze', label: '素材分析' },
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
  if (pathname.startsWith('/analyze')) return '/analyze';
  if (pathname.startsWith('/style')) return '/style';
  if (pathname.startsWith('/script')) return '/script';
  if (pathname.startsWith('/timeline-export')) return '/timeline-export';
  if (pathname.startsWith('/project')) return '/project';
  return '/';
}

function resolveCurrentStyleCategory(config, search) {
  const params = new URLSearchParams(search || '');
  const requested = params.get('categoryId');
  if (requested && config.categories.some(category => category.categoryId === requested)) {
    return requested;
  }
  return config.defaultCategory || config.categories[0]?.categoryId || '';
}

function buildStylePath(categoryId) {
  return categoryId
    ? `/style?categoryId=${encodeURIComponent(categoryId)}`
    : '/style';
}

function buildStyleSelectionScriptBriefPayload(brief, styleCategory) {
  const workflowState = styleCategory ? 'await_brief_draft' : 'choose_style';
  return {
    ...brief,
    styleCategory,
    workflowState,
    briefOverwriteApprovedAt: undefined,
    statusText: describeScriptWorkflowState(workflowState),
  };
}

function buildReviewedScriptBriefPayload(brief) {
  const hasAgentDraft = Boolean(brief.lastAgentDraftAt || brief.lastAgentDraftFingerprint);
  const workflowState = !brief.styleCategory
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
  choose_style: '请先在 /script 选择风格分类。',
  await_brief_draft: '风格已保存，请回到 Agent 生成初版 brief。',
  review_brief: '初版 brief 已生成，请在 /script 审查并保存。',
  ready_to_prepare: 'brief 已保存，请点击 准备给 Agent。',
  ready_for_agent: '脚本准备已完成，请回到 Agent 继续生成 script/current.json。',
  script_generated: '脚本已生成，可继续审稿或进入 Timeline。',
};

ReactDOM.render(<AppShell />, document.getElementById('root'));
