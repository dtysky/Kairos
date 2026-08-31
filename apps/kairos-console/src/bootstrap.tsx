import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import { ConsoleStateProvider } from './app-state';
import { AppShell } from './main.jsx';
import { kairosTheme } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('Kairos Console root element is missing');

createRoot(root).render(
  <React.StrictMode>
    <ConfigProvider theme={kairosTheme}>
      <AntApp>
        <BrowserRouter>
          <ConsoleStateProvider>
            <AppShell />
          </ConsoleStateProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
