export default function Loading() {
  return (
    <div className="page-loading" role="status">
      <div className="loading-line" />
      <h2>Loading Guilds…</h2>
      <p>Fetching the public Guild directory.</p>
    </div>
  );
}
