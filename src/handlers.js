// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the cars are published as TeslaMate's topics arrive; a scan publishes now.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Read only: no onSetValue (Gladys acks every command "not implemented").

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.configUpdated(config);
  });

  // Connection lifecycle: the configuration is read (tried again while Gladys
  // does not answer), then the status, the Discovery and the badges are sent
  // again on every connection (the core keeps them in memory only).
  gladys.on('connected', async () => {
    try {
      await app.gladysConnected();
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
