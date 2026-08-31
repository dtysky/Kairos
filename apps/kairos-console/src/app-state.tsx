import React, { createContext, useContext, useMemo, useReducer } from 'react';

type ConsoleSnapshot = {
  projectId: string;
  config: unknown;
  jobs: unknown[];
  services: unknown[];
  reviews: unknown[];
};

type ConsoleState = ConsoleSnapshot & {
  dirtySections: string[];
  sidebarCollapsed: boolean;
  taskCenterOpen: boolean;
};

type ConsoleAction =
  | { type: 'hydrate'; payload: Partial<ConsoleSnapshot> }
  | { type: 'set-dirty'; section: string; dirty: boolean }
  | { type: 'set-sidebar-collapsed'; collapsed: boolean }
  | { type: 'set-task-center-open'; open: boolean };

const initialState: ConsoleState = {
  projectId: '',
  config: null,
  jobs: [],
  services: [],
  reviews: [],
  dirtySections: [],
  sidebarCollapsed: false,
  taskCenterOpen: false,
};

function reducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  if (action.type === 'hydrate') return { ...state, ...action.payload };
  if (action.type === 'set-sidebar-collapsed') return { ...state, sidebarCollapsed: action.collapsed };
  if (action.type === 'set-task-center-open') return { ...state, taskCenterOpen: action.open };
  if (action.type === 'set-dirty') {
    const sections = new Set(state.dirtySections);
    if (action.dirty) sections.add(action.section);
    else sections.delete(action.section);
    return { ...state, dirtySections: Array.from(sections) };
  }
  return state;
}

const ConsoleStateContext = createContext<{
  state: ConsoleState;
  dispatch: React.Dispatch<ConsoleAction>;
} | null>(null);

export function ConsoleStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <ConsoleStateContext.Provider value={value}>{children}</ConsoleStateContext.Provider>;
}

export function useConsoleState() {
  const value = useContext(ConsoleStateContext);
  if (!value) throw new Error('useConsoleState must be used inside ConsoleStateProvider');
  return value;
}

export function isProjectSwitchBlocked(dirtySections: string[]) {
  return dirtySections.length > 0;
}
