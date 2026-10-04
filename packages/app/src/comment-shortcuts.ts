export function isApplePlatform(platform?: string | null) {
  if (!platform) return false;

  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function getNavigatorPlatform(): string | null {
  if (typeof navigator === "undefined") return null;

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  // Headless browsers report an empty userAgentData.platform.
  return (
    navigatorWithUserAgentData.userAgentData?.platform || navigator.platform
  );
}

export function getAddCommentShortcutLabel(platform?: string | null) {
  return isApplePlatform(platform) ? "Cmd + Option + M" : "Ctrl + Alt + M";
}

interface AddCommentShortcutEventLike {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function matchesAddCommentShortcut(
  event: AddCommentShortcutEventLike,
  platform?: string | null,
) {
  if (event.shiftKey || event.code !== "KeyM" || !event.altKey) {
    return false;
  }

  return isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
