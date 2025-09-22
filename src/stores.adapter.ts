import type { Stores } from './types';
import { createIndexedDbStores } from './stores.indexeddb';

function preferFilesystemStores(): boolean {
  const globalMode = (() => {
    try {
      return typeof globalThis !== 'undefined' ? (globalThis as any).KILN_STORAGE_MODE : undefined;
    } catch {
      return undefined;
    }
  })();
  const envMode = (() => {
    try {
      return typeof process !== 'undefined' ? process.env.KILN_STORAGE_MODE : undefined;
    } catch {
      return undefined;
    }
  })();
  if (typeof window === 'undefined') return true;
  return (globalMode || envMode || '').toLowerCase() === 'filesystem';
}

/**
 * Factory that selects the appropriate backing store based on runtime environment.
 */
export async function createStores(): Promise<Stores> {
  if (preferFilesystemStores()) {
    const { createFilesystemStores } = await import('./stores.filesystem');
    return createFilesystemStores();
  }
  return createIndexedDbStores();
}
