export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

type LoginTarget = {
  url: string;
  error: string | null;
};

// Build login URL at runtime so redirect URI reflects the current origin.
export const resolveLoginTarget = (): LoginTarget => {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL || "";
  const appId = import.meta.env.VITE_APP_ID || "";

  if (!oauthPortalUrl) {
    return {
      url: "#",
      error: "OAuth 未配置：缺少 VITE_OAUTH_PORTAL_URL，请在 .env 中配置后重启前端。",
    };
  }
  if (!appId) {
    return {
      url: "#",
      error: "OAuth 未配置：缺少 VITE_APP_ID，请在 .env 中配置后重启前端。",
    };
  }

  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const state = btoa(redirectUri);

  try {
    const url = new URL(`${oauthPortalUrl}/app-auth`);
    url.searchParams.set("appId", appId);
    url.searchParams.set("redirectUri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("type", "signIn");

    return { url: url.toString(), error: null };
  } catch (e) {
    console.warn("Invalid OAuth URL configuration", e);
    return {
      url: "#",
      error: "OAuth 配置无效：VITE_OAUTH_PORTAL_URL 不是合法 URL。",
    };
  }
};

export const getLoginUrl = () => resolveLoginTarget().url;

export const redirectToLogin = (
  onError?: (message: string) => void
): boolean => {
  const { url, error } = resolveLoginTarget();
  if (error) {
    if (onError) onError(error);
    else if (typeof window !== "undefined") window.alert(error);
    return false;
  }
  if (typeof window !== "undefined") window.location.href = url;
  return true;
};
