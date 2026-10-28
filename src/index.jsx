// React app entry point.

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.scss';
// After index.scss so the utility layer wins where it is used. Additive only —
// no preflight/reset, see tailwind.config.js.
import './tailwind.scss';
import App from './App';
import StoreProviders from './store/Providers';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <StoreProviders>
      <App />
    </StoreProviders>
  </React.StrictMode>
);
