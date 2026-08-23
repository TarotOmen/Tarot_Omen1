// Minimal Telegram WebApp bridge. No external SDK dependency required —
// Telegram injects window.Telegram.WebApp when the page is opened inside a Mini App.

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name?: string;
      username?: string;
      language_code?: string;
    };
  };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
  openTelegramLink?: (url: string) => void;
  switchInlineQuery?: (query: string, chatTypes?: string[]) => void;
  close: () => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return typeof window !== 'undefined' && window.Telegram?.WebApp ? window.Telegram.WebApp : null;
}

export function initTelegram(): TelegramWebApp | null {
  const tg = getTelegramWebApp();
  if (!tg) return null;

  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  tg.setHeaderColor?.('#0b0a0f');
  tg.setBackgroundColor?.('#0b0a0f');

  return tg;
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  getTelegramWebApp()?.HapticFeedback?.impactOccurred(style);
}

export function getTelegramUser() {
  return getTelegramWebApp()?.initDataUnsafe?.user ?? null;
}

export function getInitData(): string {
  return getTelegramWebApp()?.initData ?? '';
}

export function shareResult(text: string) {
  const tg = getTelegramWebApp();
  const encoded = encodeURIComponent(text);
  if (tg?.switchInlineQuery) {
    // Works if the bot supports inline mode.
    try {
      tg.switchInlineQuery(text, ['users', 'groups', 'channels']);
      return;
    } catch {
      // fall through to share link
    }
  }
  const shareUrl = `https://t.me/share/url?url=${encoded}`;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(shareUrl);
  } else {
    window.open(shareUrl, '_blank');
  }
}
