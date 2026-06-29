import { useState, useEffect } from 'react';

export function useUserPreference<T>(key: string, defaultValue: T, userId: string = 'guest') {
  const scopedKey = `truth:ui-pref:${userId}:${key}`;

  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const stored = localStorage.getItem(scopedKey);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(scopedKey, JSON.stringify(value));
  }, [scopedKey, value]);

  return [value, setValue] as const;
}
