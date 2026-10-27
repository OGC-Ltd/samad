// React app entry point.

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
// After index.css so the utility layer wins where it is used. Additive only —
// no preflight/reset, see tailwind.config.js.
import './tailwind.css';
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
