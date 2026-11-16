// Fixed host startup phases only. Never display raw stderr/build/auth errors.
export const STARTUP_LABELS = Object.freeze({
  queued: 'Väntar på att startas',
  starting_wrapper: 'Startar projektets värdprocess',
  project_lock: 'Kontrollerar projektlåset',
  checking_engine: 'Kontrollerar rootless Podman',
  preparing_image: 'Förbereder sandbox-image · kan bygga/hämta paket',
  image_ready: 'Sandbox-image klar',
  preparing_proxy: 'Förbereder credential-proxy på värden',
  starting_container: 'Startar container · väntar på Pi och extensions',
  rpc_ready: 'Pi har svarat · ansluter till webbservern',
  connected: 'Agentanslutningen bekräftad',
  project_busy: 'Projektet används redan · stäng dess andra session först',
  cleanup_unconfirmed: 'Containerstopp ej bekräftat · kontrollera låset på värden',
  engine_failed: 'Podman-kontrollen misslyckades · kör pis --doctor på värden',
  image_failed:
    'Image-kontroll/bygge misslyckades · kontrollera ledigt diskutrymme och pis --build',
  proxy_failed:
    'Credential-proxyn kunde inte starta · kontrollera host-inloggning/projektets proxy',
  pi_failed:
    'Pi svarade inte innan processen avslutades · kontrollera container/extension-start på värden',
  startup_timeout:
    'Pi-starten nådde tidsgränsen · kontrollera senaste startsteg och host-processer',
  registration_failed:
    'Pi svarar lokalt men agentanslutningen till webbservern kunde inte bekräftas',
  rpc_failed: 'RPC-strömmen kunde inte läsas · kontrollera Pi/extensioners protokollutskrift',
  failed: 'Starten misslyckades · kontrollera projekt/Podman på värden',
});
export const startupFailure = (phase) =>
  [
    'project_busy',
    'cleanup_unconfirmed',
    'engine_failed',
    'image_failed',
    'proxy_failed',
    'pi_failed',
    'startup_timeout',
    'registration_failed',
    'rpc_failed',
    'failed',
  ].includes(phase);
export const startupPhase = (phase) => Object.hasOwn(STARTUP_LABELS, phase);
export function startupText(startup, now = Date.now()) {
  if (!startup || !startupPhase(startup.phase)) return '';
  // This display helper is for OFFLINE roster entries, not an old success claim.
  if (startup.phase === 'connected') return 'Agenten frånkopplad · väntar på återanslutning';
  const elapsed = Number.isFinite(startup.startedAt)
    ? Math.max(0, Math.floor((now - startup.startedAt) / 1000))
    : 0;
  const since = Number.isFinite(startup.updatedAt)
    ? Math.max(0, Math.floor((now - startup.updatedAt) / 1000))
    : 0;
  return `${STARTUP_LABELS[startup.phase]} · ${elapsed} s totalt${since >= 15 && startup.phase !== 'connected' && !startupFailure(startup.phase) ? ` · väntar sedan ${since} s (ingen ny stegstatus; inte en bekräftad låsning)` : ''}`;
}
