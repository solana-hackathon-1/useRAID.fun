'use client';
import { useEffect } from 'react';
import './globals.css';

export default function GlobalError({ error, retry }: { error: Error; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body>
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
