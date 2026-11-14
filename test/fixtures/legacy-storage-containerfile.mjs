// Frozen pre-optimization ordering, used ONLY by the opt-in host benchmark.
// Installs are performed by Podman, never by this Node process on the host.
import { BASE_IMAGE, PI_VERSION } from '../../src/container.js';
import { extensionManifest, IMAGE_AGENT_DIR, shellQuote } from '../../src/extensions.js';
export function legacyStorageContainerfile(config) {
  const packages = [...new Set(['bash', 'ca-certificates', 'git', 'ripgrep', ...config.image.packages])];
  const installs = extensionManifest(config.extensions).map(entry => `RUN PI_CODING_AGENT_DIR=${IMAGE_AGENT_DIR} PI_OFFLINE=1 NPM_CONFIG_IGNORE_SCRIPTS=true pi install ${shellQuote(entry.source)}`).join('\n');
  return `FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ${packages.map(shellQuote).join(' ')} && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}
RUN mkdir -p ${IMAGE_AGENT_DIR}
${installs}
${config.image.extraInstructions.join('\n')}
USER root
COPY extensions.json image-entry.mjs fetch-bridge.mjs request-apt.mjs codex-auto.mjs update-probe.mjs probe-policy.json pi-launcher /opt/pis/
RUN mv /usr/local/bin/pi /usr/local/bin/pis-pi-real && cp /opt/pis/pi-launcher /usr/local/bin/pi && chmod 755 /usr/local/bin/pi && chmod -R a+rX /opt/pis && mkdir -p /pis/home && chmod 1777 /pis/home
WORKDIR /pis/home
USER node
ENTRYPOINT ["/usr/local/bin/node", "/opt/pis/image-entry.mjs"]
CMD ["pi"]
`;
}
