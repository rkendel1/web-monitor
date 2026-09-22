import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthState } from '../src/shared/auth-detection.js';

test('detectAuthState correctly identifies different auth states', () => {
  // 1. Authenticated page
  const authHtml = `
    <html>
      <body>
        <h1>Welcome, user</h1>
        <p>Your current balance is $499</p>
        <a href="/logout">Sign out</a>
      </body>
    </html>
  `;
  assert.equal(detectAuthState(authHtml, 'https://example.com/dashboard'), 'authenticated');

  // 2. Login page
  const loginHtml = `
    <html>
      <body>
        <form>
          <input type="text" name="username">
          <input type="password" name="password">
          <button type="submit">Log in</button>
        </form>
      </body>
    </html>
  `;
  assert.equal(detectAuthState(loginHtml, 'https://example.com/login-form'), 'required');

  // 3. Redirected login page (by URL)
  const redirectHtml = `
    <html>
      <body>
        <h1>Redirection...</h1>
      </body>
    </html>
  `;
  assert.equal(detectAuthState(redirectHtml, 'https://example.com/auth/login?redirect=%2Fdashboard'), 'required');

  // 4. Public page
  const publicHtml = `
    <html>
      <body>
        <h1>My Public Blog</h1>
        <p>This is a great day to write code!</p>
      </body>
    </html>
  `;
  assert.equal(detectAuthState(publicHtml, 'https://example.com/blog'), 'public');

  // 5. Unknown state
  assert.equal(detectAuthState(null, 'https://example.com/blog'), 'unknown');
});
