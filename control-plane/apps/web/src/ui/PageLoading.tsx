export function PageLoading() {
  return (
    <div className="ocp-center w-full h-full min-h-200px">
      <span
        className="inline-block size-24px border-2 border-t-transparent border-accent rd-full"
        style={{ animation: 'ocp-spin 0.7s linear infinite' }}
        aria-label="Loading"
        role="status"
      />
    </div>
  );
}
