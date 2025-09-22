/**
 * Provide browser globals when running headless under Bun/Node.
 */
const g: any = globalThis as any;

g.KILN_HEADLESS = true;

if (typeof g.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const envPrefix = 'KILN_LOCALSTORAGE_';

  const getFromEnv = (key: string): string | null => {
    try {
      const envKey = `${envPrefix}${key.toUpperCase()}`;
      const val = typeof process !== 'undefined' ? process.env?.[envKey] : undefined;
      return val != null ? String(val) : null;
    } catch {
      return null;
    }
  };

  g.localStorage = {
    getItem(key: string): string | null {
      if (store.has(key)) return store.get(key) ?? null;
      const envVal = getFromEnv(key);
      if (envVal != null) {
        store.set(key, envVal);
        return envVal;
      }
      return null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    get length(): number {
      return store.size;
    },
  };
}

const defaultOrigin = 'http://localhost';

if (typeof g.window === 'undefined') {
  g.window = g;
}

if (typeof g.location === 'undefined') {
  try {
    g.location = new URL(defaultOrigin);
  } catch {
    g.location = { origin: defaultOrigin };
  }
}

if (!g.window.location) {
  g.window.location = g.location;
}

if (typeof g.document === 'undefined') {
  g.document = {
    querySelector: () => null,
  } as any;
}
