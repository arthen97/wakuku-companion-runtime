// No cloud connection is made automatically. Enabled here only permits a user-initiated
// broker health check. The broker must have local credentials + a positive human-set budget.
// Never put API keys in this file.
// A configured broker still has to report voice=true before microphone access.
export const CONFIG = Object.freeze({
  brokerUrl: `${window.location.origin}/broker`,
  liveEnabled: false,
  sessionCapSeconds: 60,
  voice: 'marin',
});
