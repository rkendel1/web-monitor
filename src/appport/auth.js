import { appPortClient, getConfig, setConfig } from './client.js';

export class ApiKeyAuth {
  /**
   * Authenticate with the provided config.
   *
   * @param {object} config - Configuration object with baseUrl, tenantId, and apiKey.
   * @returns {Promise<object>} The session information.
   */
  async authenticate(config) {
    const trimmed = await setConfig(config);
    return this.getSession();
  }

  /**
   * Retrieve the current session information.
   *
   * @returns {Promise<object|null>} The session information, or null if unauthenticated.
   */
  async getSession() {
    const config = await getConfig();
    if (!config) {
      return null;
    }
    try {
      return await appPortClient.getSession();
    } catch (error) {
      console.warn('Failed to retrieve session:', error);
      return null;
    }
  }

  /**
   * Refresh the authenticated session.
   *
   * @returns {Promise<object|null>} The refreshed session.
   */
  async refresh() {
    return this.getSession();
  }

  /**
   * Sign out, clearing any stored credentials.
   */
  async signOut() {
    await chrome.storage.local.remove('appportConfig');
  }
}

export const ExtensionAuth = {
  adapter: new ApiKeyAuth(),

  async authenticate(config) {
    return this.adapter.authenticate(config);
  },

  async getSession() {
    return this.adapter.getSession();
  },

  async refresh() {
    return this.adapter.refresh();
  },

  async signOut() {
    return this.adapter.signOut();
  }
};
