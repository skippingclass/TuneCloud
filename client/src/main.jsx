import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { getPwaController } from './pwa.js';
import './index.css';
import './mix.css';

getPwaController().start({ registerWorker: import.meta.env.PROD });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
