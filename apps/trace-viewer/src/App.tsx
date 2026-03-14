import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { TraceListPage } from './components/TraceListPage';
import { TraceOverviewPage } from './components/TraceOverviewPage';
import { DivergencePage } from './components/DivergencePage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/traces" replace />} />
        <Route path="/traces" element={<TraceListPage />} />
        <Route path="/traces/:traceId" element={<TraceOverviewPage />} />
        <Route path="/compare" element={<DivergencePage />} />
      </Route>
    </Routes>
  );
}
