import express from 'express';
import fs from 'fs';
import path from 'path';
import { app, startServer } from './api';

const frontendDist = path.resolve(__dirname, '..', 'frontend', 'dist');
const indexHtml = path.join(frontendDist, 'index.html');

// Serve static frontend files in production
app.use(express.static(frontendDist));

// SPA catch-all: any non-API route returns index.html
// This must be after API routes are registered (they're registered when ./api module loads)
app.get(/^\/(?!api\/).*/, (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res.status(404).json({
      error: {
        code: 'FRONTEND_NOT_BUILT',
        message: 'Frontend build not found. Run npm run build in backend/frontend.',
        retryable: false,
      },
    });
  }
  res.sendFile(indexHtml, (err) => {
    if (err) {
      res.status(500).json({
        error: {
          code: 'FRONTEND_UNAVAILABLE',
          message: 'Failed to serve frontend index.html',
          retryable: false,
        },
      });
    }
  });
});

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
