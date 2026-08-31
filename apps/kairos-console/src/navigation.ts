export type NavigationItem = { path: string; label: string; icon: string };
export type NavigationGroup = { label: string; items: NavigationItem[] };

export const navigationGroups: NavigationGroup[] = [
  { label: '工作台', items: [{ path: '/', label: '总览', icon: 'overview' }] },
  {
    label: '素材准备',
    items: [
      { path: '/ingest-gps', label: '导入与 GPS', icon: 'ingest' },
      { path: '/color', label: '达芬奇调色', icon: 'color' },
    ],
  },
  {
    label: '素材理解',
    items: [
      { path: '/analyze', label: '素材分析', icon: 'analyze' },
      { path: '/chronology', label: '编年史', icon: 'chronology' },
    ],
  },
  {
    label: '创作',
    items: [
      { path: '/style', label: '风格分析', icon: 'style' },
      { path: '/edit', label: '剪辑流', icon: 'edit' },
      { path: '/timeline-export', label: '时间线与导出', icon: 'timeline' },
    ],
  },
  { label: '系统', items: [{ path: '/project', label: '项目', icon: 'project' }] },
];

export function resolveNavigationPath(pathname: string) {
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
