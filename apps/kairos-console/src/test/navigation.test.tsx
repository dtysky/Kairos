import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConsoleStateProvider } from '../app-state';
import { ConsoleSidebar } from '../components/console-sidebar';
import { navigationGroups, resolveNavigationPath } from '../navigation';

describe('console navigation', () => {
  it('keeps the approved groups and aligns every item in one shared sidebar', () => {
    expect(navigationGroups.map(group => group.label)).toEqual(['工作台', '素材准备', '素材理解', '创作', '系统']);
    render(
      <MemoryRouter initialEntries={['/chronology']}>
        <ConsoleStateProvider><ConsoleSidebar /></ConsoleStateProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '编年史' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page')).toHaveLength(1);
  });

  it('maps compatibility paths to the canonical selected item', () => {
    expect(resolveNavigationPath('/analyze/monitor')).toBe('/analyze');
    expect(resolveNavigationPath('/script')).toBe('/edit');
    expect(resolveNavigationPath('/style/monitor/travel-doc')).toBe('/style');
  });
});
