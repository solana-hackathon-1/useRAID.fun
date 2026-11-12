'use client';
import { useEffect, useState } from 'react';
import './globals.css';
import { EnvironmentLabel, type EnvironmentLabelValue } from '@/components/environment-label';
import { fetchEnvironmentLabel } from '@/lib/environment-label-client';

export default function GlobalError({ error, retry }: { error: Error; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  // This page replaces the root layout, so the Shell's label is absent: ask the server for the same validated label.
  const [environment, setEnvironment] = useState<EnvironmentLabelValue | null>(null);
  useEffect(() => {
    let live = true;
    void fetchEnvironmentLabel().then((value) => {
      if (live) setEnvironment(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <html lang="en">
      <body>
        {environment && <EnvironmentLabel environment={environment} />}
        <title>useRAID.fun is unavailable</title>
        <div className="empty">
          <h1>Activity is unavailable</h1>
          <p>We couldn’t load the latest campaign data. Please try again in a moment.</p>
          <button className="button" onClick={retry}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
