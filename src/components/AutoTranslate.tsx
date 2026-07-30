import { useEffect } from 'react';
import { usePreferences } from '../lib/preferences';

// Privacy boundary: never scan or transmit rendered DOM text. Clinical screens
// contain PHI, and a generic runtime translator cannot reliably distinguish it
// from static interface copy. Keep only document language/direction behavior;
// future translations must use curated static message IDs at render time.
export default function AutoTranslate() {
  const { language } = usePreferences();

  useEffect(() => {
    const lang = language || 'en';
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [language]);

  return null;
}
