import 'virtual:uno.css';
import '@arco-design/web-react/dist/css/arco.css';
import './styles/themes/palette.css';
import './styles/themes/shell-tokens.css';
import './styles/arco-override.css';
import './styles/markdown.css';
import 'diff2html/bundles/css/diff2html.min.css';
import './styles/diff.css';
import './styles/global.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from '@arco-design/web-react';
import { SWRConfig } from 'swr';
import { App } from './App';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme/ThemeProvider';
import { api } from './api';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SWRConfig value={{ fetcher: (url: string) => api(url), revalidateOnFocus: false }}>
      <ThemeProvider>
        <ConfigProvider>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </ConfigProvider>
      </ThemeProvider>
    </SWRConfig>
  </React.StrictMode>
);
