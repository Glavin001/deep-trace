import { Outlet, Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getHealth } from '../api/client';

export function Layout() {
  const location = useLocation();
  const [health, setHealth] = useState<{ status: string; clickhouse: string } | null>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: 'error', clickhouse: 'unreachable' }));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-surface-1 border-b border-surface-3 px-6 py-3 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-6">
          <Link to="/traces" className="flex items-center gap-2 hover:opacity-80">
            <svg width="24" height="24" viewBox="0 0 32 32" className="shrink-0">
              <rect width="32" height="32" rx="6" fill="#1a1a25"/>
              <path d="M8 10h16M8 16h12M8 22h8" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round"/>
              <circle cx="24" cy="22" r="3" fill="#a78bfa"/>
            </svg>
            <span className="text-lg font-semibold text-white">Deep Trace</span>
          </Link>

          <nav className="flex items-center gap-1">
            <Link
              to="/traces"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                location.pathname.startsWith('/traces')
                  ? 'bg-surface-2 text-white'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-2'
              }`}
            >
              Traces
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {health && (
            <div className="flex items-center gap-2 text-xs">
              <div
                className={`w-2 h-2 rounded-full ${
                  health.status === 'ok' ? 'bg-accent-green' : 'bg-accent-amber'
                }`}
              />
              <span className="text-gray-500">
                ClickHouse: {health.clickhouse === 'connected' ? 'connected' : 'disconnected'}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
