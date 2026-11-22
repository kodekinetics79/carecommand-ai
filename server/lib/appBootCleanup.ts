export async function withAppCleanupOnFailure<T>(
  app: { close(): Promise<unknown> },
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try { await app.close(); } catch { /* preserve the original boot error */ }
    throw error;
  }
}
