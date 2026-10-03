'use client';
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <div className="empty">
      <h1>Activity is unavailable</h1>
      <p>We couldn’t load the latest campaign data. Please try again in a moment.</p>
      <button className="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
