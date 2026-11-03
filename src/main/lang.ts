// Holds the currently resolved UI language for main-process strings
// (tray menu, notifications, status messages).
import { resolveUiLang, translate, UiLang } from '../shared/i18n';

let current: UiLang = 'en';

export function setMainLang(pref: string, systemLocale: string): UiLang {
  current = resolveUiLang(pref, systemLocale);
  return current;
}

export function getMainLang(): UiLang {
  return current;
}

export function tMain(key: string, vars?: Record<string, string | number>): string {
  return translate(current, key, vars);
}
