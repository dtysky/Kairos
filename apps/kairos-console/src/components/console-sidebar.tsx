import {
  AppstoreOutlined,
  BgColorsOutlined,
  DatabaseOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  ProjectOutlined,
  RadarChartOutlined,
  ScissorOutlined,
} from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { Link, useLocation } from 'react-router-dom';
import { navigationGroups, resolveNavigationPath } from '../navigation';
import { useConsoleState } from '../app-state';

const icons: Record<string, React.ReactNode> = {
  overview: <AppstoreOutlined />,
  ingest: <FolderOpenOutlined />,
  color: <BgColorsOutlined />,
  analyze: <RadarChartOutlined />,
  chronology: <NodeIndexOutlined />,
  style: <FileSearchOutlined />,
  edit: <ScissorOutlined />,
  timeline: <DatabaseOutlined />,
  project: <ProjectOutlined />,
};

export function ConsoleSidebar() {
  const location = useLocation();
  const { state, dispatch } = useConsoleState();
  const activePath = resolveNavigationPath(location.pathname);
  const collapsed = state.sidebarCollapsed;

  return (
    <aside className={`console-sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Kairos 主导航">
      <div className="console-brand">
        <div className="console-brand-mark">K</div>
        {!collapsed ? (
          <div>
            <strong>Kairos</strong>
            <span>Console</span>
          </div>
        ) : null}
        <Button
          type="text"
          className="sidebar-toggle"
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => dispatch({ type: 'set-sidebar-collapsed', collapsed: !collapsed })}
        />
      </div>
      <nav className="sidebar-groups">
        {navigationGroups.map(group => (
          <div key={group.label} className="sidebar-group">
            {!collapsed ? <div className="sidebar-group-label">{group.label}</div> : null}
            {group.items.map(item => {
              const link = (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`sidebar-item${activePath === item.path ? ' is-active' : ''}`}
                  aria-label={item.label}
                  aria-current={activePath === item.path ? 'page' : undefined}
                >
                  <span className="sidebar-item-icon">{icons[item.icon]}</span>
                  {!collapsed ? <span>{item.label}</span> : null}
                </Link>
              );
              return collapsed ? <Tooltip key={item.path} title={item.label} placement="right">{link}</Tooltip> : link;
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
