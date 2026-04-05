import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { BrowserRouter as Router, Link, Redirect, Route, Switch } from 'react-router-dom';
import { Button, Card, Menu, MenuItem, Tag } from 'hana-ui';
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
  fetchWorkspaceStatus,
  resolveProjectReview,
  saveProjectSection,
  startJob,
} from './api.js';
import { EmptyPanel, MonitorPage } from './monitor-page.jsx';
import {
  CaptureTimeOverridesEditor,
  ManualItineraryEditor,
  ProjectBriefEditor,
  ReviewQueuePanel,
  ScriptBriefEditor,
  StyleSourcesEditor,
} from './workspace-forms.jsx';

function AppShell() {
  const [status, setStatus] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [projectId, setProjectId] = useState(window.localStorage.getItem('kairos.console.projectId') || '');
  const [config, setConfig] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [projectProgress, setProjectProgress] = useState(null);
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    refreshStatus();
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
  const activeJobs = useMemo(
    () => (status?.jobs || []).filter(job => ['queued', 'running', 'blocked'].includes(job.status)),
    [status],
  );
  const mlService = services.find(service => service.name === 'ml') || null;
  const dashboardService = services.find(service => service.name === 'dashboard') || null;
  const openReviewCount = reviews.filter(review => review.status === 'open').length;

  const setProjectBrief = makeSectionSetter(setConfig, 'projectBrief');
  const setManualItinerary = makeSectionSetter(setConfig, 'manualItinerary');
  const setScriptBrief = makeSectionSetter(setConfig, 'scriptBrief');
  const setStyleSources = makeSectionSetter(setConfig, 'styleSources');

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
      setReviews(nextReviews.items || []);
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
        'style-sources': config.styleSources,
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

  async function runWorkflow(jobType) {
    if (!projectId) return;
    const busyKey = `job:${jobType}`;
    setBusy(current => ({ ...current, [busyKey]: true }));
    try {
      await startJob(projectId, jobType, {});
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
                  render={() => (
                    <AnalyzeMonitorRoute projectId={projectId} />
                  )}
                />
                <Route
                  exact
                  path="/analyze"
                  render={() => (
                    <AnalyzeHubPage
                      projectId={projectId}
                      projectProgress={projectProgress}
                      activeJobs={activeJobs}
                      busy={busy}
                      onRun={() => runWorkflow('analyze')}
                    />
                  )}
                />
                <Route
                  exact
                  path="/style/monitor/:categoryId?"
                  render={props => (
                    <StyleMonitorRoute
                      projectId={projectId}
                      categoryId={props.match.params.categoryId}
                    />
                  )}
                />
                <Route
                  exact
                  path="/style"
                  render={() => (
                    <StyleHubPage
                      projectId={projectId}
                      config={config?.styleSources}
                      setStyleSources={setStyleSources}
                      saveSection={saveSection}
                      busy={busy}
                      onRun={() => runWorkflow('style-analysis')}
                    />
                  )}
                />
                <Route
                  exact
                  path="/script"
                  render={() => (
                    <ScriptPage
                      config={config?.scriptBrief}
                      setScriptBrief={setScriptBrief}
                      saveSection={saveSection}
                      busy={busy}
                      activeJobs={activeJobs}
                      onRun={() => runWorkflow('script')}
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
    { path: '/analyze', label: '素材分析', summary: '查看分析状态、恢复进度并进入专属监控页。' },
    { path: '/style', label: '风格分析', summary: '维护 style sources，进入分类级风格监控页。' },
    { path: '/script', label: '脚本', summary: '维护 script-brief，并发起 agent script job。' },
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

function AnalyzeHubPage({ projectId, projectProgress, activeJobs, busy, onRun }) {
  const analyzeJobs = activeJobs.filter(job => job.jobType === 'analyze');
  return (
    <div className="route-page">
      <RouteIntro title="素材分析" subtitle="从分析摘要进入专属监控页，恢复或重启时继续沿用现有 checkpoint。" />
      <div className="card-grid card-grid-two">
        <Card className="panel">
          <div className="section-header">
            <h2>分析摘要</h2>
            <Tag>{projectProgress?.status || 'idle'}</Tag>
          </div>
          {projectProgress ? (
            <div className="stack-list">
              <div className="job-item">
                <div>
                  <strong>{projectProgress.stepLabel || projectProgress.step}</strong>
                  <div className="muted">{projectProgress.detail}</div>
                </div>
                <Tag>{`${projectProgress.current || 0}/${projectProgress.total || 0}`}</Tag>
              </div>
              {projectProgress.fileName ? <div className="muted">{projectProgress.fileName}</div> : null}
            </div>
          ) : (
            <p className="muted">当前还没有项目级分析进度。</p>
          )}
          <div className="actions">
            <Button onClick={onRun} disabled={busy['job:analyze'] || !projectId}>{busy['job:analyze'] ? '启动中…' : '启动 Analyze'}</Button>
            <Link className="text-link" to="/analyze/monitor">进入监控页</Link>
          </div>
        </Card>
        <Card className="panel">
          <div className="section-header">
            <h2>活跃 Analyze Job</h2>
            <Tag>{`${analyzeJobs.length} 个`}</Tag>
          </div>
          {analyzeJobs.length === 0 ? <p className="muted">当前没有受控 analyze job。若仍有进度推进，可能是孤儿 worker。</p> : null}
          <div className="stack-list">
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
    </div>
  );
}

function StyleHubPage({ projectId, config, setStyleSources, saveSection, busy, onRun }) {
  if (!config) {
    return (
      <div className="route-page">
        <EmptyPanel label="风格来源配置尚未加载完成。" />
      </div>
    );
  }
  const defaultCategory = config.defaultCategory || config.categories[0]?.categoryId || '';
  return (
    <div className="route-page">
      <RouteIntro title="风格分析" subtitle="配置 style sources，并通过专属监控页跟踪每个风格分类的 agent 分析过程。" />
      <Card className="panel">
        <div className="section-header">
          <h2>运行入口</h2>
          <Tag>{`${config.categories.length} 个分类`}</Tag>
        </div>
        <div className="actions">
          <Button onClick={onRun} disabled={busy['job:style-analysis'] || !projectId}>{busy['job:style-analysis'] ? '启动中…' : '启动 Style Analysis'}</Button>
          <Link className="text-link" to={defaultCategory ? `/style/monitor/${encodeURIComponent(defaultCategory)}` : '/style/monitor'}>进入监控页</Link>
        </div>
        {config.categories.length > 0 ? (
          <div className="stack-list">
            {config.categories.map(category => (
              <div key={category.categoryId} className="job-item">
                <div>
                  <strong>{category.displayName}</strong>
                  <div className="muted">{`${category.sources.length} 个来源 · ${category.categoryId}`}</div>
                </div>
                <Link className="text-link" to={`/style/monitor/${encodeURIComponent(category.categoryId)}`}>查看监控</Link>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">还没有配置 style category。</p>
        )}
      </Card>
      <StyleSourcesEditor
        config={config}
        setConfig={setStyleSources}
        onSave={() => saveSection('style-sources')}
        busy={busy['style-sources']}
      />
    </div>
  );
}

function ScriptPage({ config, setScriptBrief, saveSection, busy, activeJobs, onRun }) {
  const scriptJobs = activeJobs.filter(job => job.jobType === 'script');
  return (
    <div className="route-page">
      <RouteIntro title="脚本" subtitle="维护 script-brief，并把 agent 脚本生成作为后台 job 管理。" />
      <Card className="panel">
        <div className="section-header">
          <h2>Script Job</h2>
          <Tag>{`${scriptJobs.length} 个活跃 job`}</Tag>
        </div>
        <div className="actions">
          <Button onClick={onRun} disabled={busy['job:script']}>{busy['job:script'] ? '启动中…' : '启动 Script Job'}</Button>
        </div>
      </Card>
      <ScriptBriefEditor
        config={config}
        setConfig={setScriptBrief}
        onSave={() => saveSection('script-brief')}
        busy={busy['script-brief']}
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
          <Button onClick={() => onControlMl('start')} disabled={busy['ml:start']}>{busy['ml:start'] ? '处理中…' : '启动 ML'}</Button>
          <Button onClick={() => onControlMl('restart')} disabled={busy['ml:restart']}>{busy['ml:restart'] ? '处理中…' : '重启 ML'}</Button>
          <Button onClick={() => onControlMl('stop')} disabled={busy['ml:stop']}>{busy['ml:stop'] ? '处理中…' : '停止 ML'}</Button>
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

function AnalyzeMonitorRoute({ projectId }) {
  return (
    <MonitorLoader
      kind="analyze"
      projectId={projectId}
      emptyLabel="当前项目还没有可展示的 Analyze 监控数据。"
    />
  );
}

function StyleMonitorRoute({ projectId, categoryId }) {
  return (
    <MonitorLoader
      kind="style"
      projectId={projectId}
      categoryId={categoryId}
      emptyLabel="当前分类还没有可展示的风格分析监控数据。"
    />
  );
}

function MonitorLoader({ kind, projectId, categoryId, emptyLabel }) {
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const next = !projectId
          ? null
          : kind === 'style'
            ? await fetchStyleMonitor(projectId, categoryId)
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
      <MonitorPage model={model} emptyLabel={emptyLabel} />
    </div>
  );
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

ReactDOM.render(<AppShell />, document.getElementById('root'));
