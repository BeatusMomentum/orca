import type * as ParcelWatcher from '@parcel/watcher'

/** Normalize the CJS package while keeping native loading lazy. */
export async function loadParcelWatcher(): Promise<typeof ParcelWatcher> {
  const { subscribe } = await import('@parcel/watcher')
  return { subscribe } as unknown as typeof ParcelWatcher
}
