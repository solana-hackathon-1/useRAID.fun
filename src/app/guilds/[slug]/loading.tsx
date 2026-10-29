export default function Loading() {
  return (
    <div className="page-loading" role="status">
      <div className="loading-line" />
      <h2>Loading Guild…</h2>
      <p>Fetching the public profile and published updates.</p>
    </div>
  );
}
