import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell/AppShell';
import { ReleaseDetail } from './components/ReleaseDetail/ReleaseDetail';
import { RequestsPage } from './components/RequestsPage/RequestsPage';
import { RecordChangeSheet } from './components/RecordChangeSheet/RecordChangeSheet';
import { ReleasesPage } from './routes/ReleasesPage';

export default function App() {
  const [recordSheetOpen, setRecordSheetOpen] = useState(false);

  return (
    <BrowserRouter>
      <AppShell onRecordChange={() => setRecordSheetOpen(true)}>
        <Routes>
          <Route path="/" element={<Navigate to="/releases" replace />} />
          <Route path="/releases" element={<ReleasesPage />} />
          <Route path="/releases/:releaseId" element={<ReleaseDetail />} />
          <Route path="/requests" element={<RequestsPage />} />
        </Routes>

        {recordSheetOpen && (
          <RecordChangeSheet onClose={() => setRecordSheetOpen(false)} />
        )}
      </AppShell>
    </BrowserRouter>
  );
}