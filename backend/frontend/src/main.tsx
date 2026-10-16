import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource-variable/spline-sans-mono';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/fonts.css';
import './styles/patterns.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);