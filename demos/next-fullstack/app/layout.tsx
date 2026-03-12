import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'deep-trace Next.js demo',
  description: 'Frontend and backend OpenTelemetry into a local collector and ClickHouse.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
