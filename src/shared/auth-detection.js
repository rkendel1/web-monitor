/**
 * Detects the authentication state of a page based on its HTML and URL.
 *
 * @param {string} html - The page HTML content.
 * @param {string} url - The page URL.
 * @returns {'public'|'authenticated'|'authentication_required'|'unknown'} The detected state.
 */
export function detectAuthState(html, url) {
  if (!html) {
    return 'unknown';
  }

  const htmlLower = html.toLowerCase();
  const urlLower = String(url ?? '').toLowerCase();

  // 1. authentication-required / login page redirect detection:
  // Is there a password input?
  const hasPasswordInput = /<input[^>]+type=["']password["']/i.test(html) ||
                            /type=["']password["'][^>]*>/i.test(html);

  // Common login/signin form / boundary indicators
  const hasLoginForm = htmlLower.includes('name="login"') ||
                       htmlLower.includes('id="login"') ||
                       htmlLower.includes('action="/login"') ||
                       htmlLower.includes('action="/signin"') ||
                       htmlLower.includes('action="/auth"');

  // Does the URL point to a login or sign-in page?
  const isLoginUrl = urlLower.includes('login') ||
                    urlLower.includes('signin') ||
                    urlLower.includes('signup') ||
                    urlLower.includes('auth') ||
                    urlLower.includes('sign-in') ||
                    urlLower.includes('log-in');

  if (hasPasswordInput || hasLoginForm || isLoginUrl) {
    return 'authentication_required';
  }

  // 2. authenticated page currently accessible detection:
  // Look for logout or profile indicators, assuming we are logged in.
  const hasLogout = /sign\s*out/i.test(html) ||
                    /log\s*out/i.test(html) ||
                    /logout/i.test(html) ||
                    /logoff/i.test(html) ||
                    /my\s*account/i.test(html) ||
                    /user\s*profile/i.test(html) ||
                    /dashboard/i.test(html) ||
                    /welcome,\s*\w+/i.test(html);

  if (hasLogout) {
    return 'authenticated';
  }

  // 3. If none of the above matches, it's public.
  return 'public';
}

export function normalizeAuthState(state) {
  return state === 'required' ? 'authentication_required' : state;
}
