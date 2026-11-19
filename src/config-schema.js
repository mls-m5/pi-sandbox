// Generated beside project.json so JSON-aware editors can describe new fields.
import { DEFAULT_EXTENSIONS } from './extensions.js';
export const SCHEMA_REFERENCE = './project.schema.json';
export const HINTS = {
  credentials:
    'New projects default to openai-codex host OAuth. Use pis --login openai|berget|mistral|custom|ollama, then select that provider (ollama is keyless host-loopback only); its matching host profile is used automatically. No keys/environment-key sources belong in project configuration. Omit proxy for credential-free launches. Direct credential forwarding is disabled; env must be []. Examples below are inert.',
  extensions:
    'Pi install sources baked into the image, e.g. npm:pi-web-access@0.40.0. Use [] to disable defaults. Changes rebuild the image; no source paths or -e flags are needed.',
  updates:
    'Opt in once with pis --updates on (or all to include exact npm pins). Only tested Pi patch/npm image updates activate on later launches. Off freezes the current managed release; rollback disables automatic updates.',
  network:
    'Optional message network: give projects the same name (see examples.network) so their running agents can exchange short messages via the host. Delete the field for no messaging. See docs/network.md.',
  image:
    'packages are apt names; extraInstructions are trusted single-line RUN instructions. Never put credentials here.',
  mounts:
    'Explicit extra directories at identical absolute paths. Access defaults to read-only. The project root is already shared read-write.',
  examples:
    'Documentation only: copy a value into its active field to enable it. Missing defaults/hints are restored and JSON is formatted when loaded or saved with pis --edit.',
};

export const PROJECT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'pis project configuration',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'id', 'root', 'image', 'mounts', 'credentials', 'extensions'],
  properties: {
    $schema: { const: SCHEMA_REFERENCE },
    version: { const: 1 },
    agent: {
      enum: ['pi', 'claude'],
      default: 'pi',
      description:
        'claude runs official Claude Code with separate state. Its subscription token stays on the host (pis --login claude) and is added by a Claude-only host proxy; credentials.proxy remains Pi-only.',
    },
    network: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{0,31}$',
      description:
        'Optional message network. Projects with the same network name can exchange short messages through the host (send_message/receive_messages/list_peers). Omit for no messaging. Example: "team-a".',
    },
    id: {
      type: 'string',
      pattern: '^[a-z0-9]{5}$',
      description: 'Managed project identity; do not edit.',
    },
    name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' },
    root: {
      type: 'string',
      description: 'Canonical project root; use pis --relocate to change it.',
    },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Additional apt packages.',
        },
        extraInstructions: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description:
            'Trusted single-line RUN instructions, without continuation or build mounts.',
        },
      },
    },
    mounts: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: {
          source: { type: 'string' },
          access: { enum: ['read-only', 'read-write'], default: 'read-only' },
        },
      },
    },
    credentials: {
      type: 'object',
      additionalProperties: false,
      description: HINTS.credentials,
      properties: {
        env: {
          type: 'array',
          maxItems: 0,
          default: [],
          description: 'Must be empty. Real credentials are available only to the host proxy.',
        },
        proxy: {
          type: 'object',
          additionalProperties: false,
          required: ['provider'],
          properties: {
            provider: {
              enum: ['openai', 'berget', 'mistral', 'custom', 'ollama', 'openai-codex'],
              description: 'API-key, host OAuth or explicitly configured local Ollama proxy.',
            },
            profile: {
              enum: ['openai', 'berget', 'mistral', 'custom', 'ollama'],
              description:
                'Optional legacy alias matching the provider; login profile is selected automatically. Never stores a key.',
            },
            models: {
              type: 'array',
              items: { type: 'string' },
              default: [],
              description:
                'Exact model allowlist; empty allows any model except Ollama, which defaults to its configured host-profile models.',
            },
            discoverModels: {
              type: 'boolean',
              default: true,
              description:
                'Berget only: fetch the public catalogue once at launch, without credentials. False uses bundled chat models.',
            },
            modelOverrides: {
              type: 'object',
              maxProperties: 100,
              description:
                'Berget only: explicit model metadata, not a request allowlist. Set both token limits from verified provider information.',
              propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$' },
              additionalProperties: {
                type: 'object',
                additionalProperties: false,
                required: ['contextWindow', 'maxTokens'],
                properties: {
                  contextWindow: { type: 'integer', minimum: 1, maximum: 10000000 },
                  maxTokens: { type: 'integer', minimum: 1, maximum: 10000000 },
                  reasoning: { type: 'boolean' },
                  input: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 2,
                    uniqueItems: true,
                    items: { enum: ['text', 'image'] },
                    contains: { const: 'text' },
                  },
                },
              },
            },
            maxRequests: { type: 'integer', minimum: 1, maximum: 100000, default: 1000 },
            maxConcurrent: { type: 'integer', minimum: 1, maximum: 64, default: 4 },
          },
          allOf: [
            {
              if: { properties: { provider: { const: 'openai-codex' } } },
              then: { not: { required: ['profile'] } },
            },
            {
              if: { properties: { provider: { not: { const: 'berget' } } } },
              then: {
                not: {
                  anyOf: [{ required: ['discoverModels'] }, { required: ['modelOverrides'] }],
                },
              },
            },
          ],
        },
      },
    },
    updates: {
      type: 'object',
      additionalProperties: false,
      description: HINTS.updates,
      properties: {
        enabled: { type: 'boolean', default: false },
        includePinnedExtensions: {
          type: 'boolean',
          default: false,
          description:
            'Explicit consent to follow compatible updates of exact image npm pins without rewriting their declared sources.',
        },
      },
    },
    extensions: {
      type: 'array',
      uniqueItems: true,
      default: DEFAULT_EXTENSIONS,
      description: HINTS.extensions,
      items: { type: 'string', pattern: '^npm:' },
    },
    examples: { type: 'object', description: 'Inert examples; never executed or mounted.' },
    hints: {
      type: 'object',
      additionalProperties: false,
      description: 'Wrapper-generated documentation.',
      properties: Object.fromEntries(
        Object.entries(HINTS).map(([key, value]) => [key, { type: 'string', default: value }]),
      ),
    },
  },
};
