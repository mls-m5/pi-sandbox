// Generated beside project.json so JSON-aware editors can describe new fields.
import { DEFAULT_EXTENSIONS } from './extensions.js';
export const SCHEMA_REFERENCE = './project.schema.json';
export const HINTS = {
  credentials: 'Choose one mode: OpenAI/Berget with keyEnv or a matching host profile (not both), custom with the custom host profile, openai-codex with host OAuth, or no proxy for direct env forwarding. Examples below are inert.',
  extensions: 'Pi install sources baked into the image, e.g. npm:pi-web-access@0.40.0. Use [] to disable defaults. Changes rebuild the image; no source paths or -e flags are needed.',
  image: 'packages are apt names; extraInstructions are trusted single-line RUN instructions. Never put credentials here.',
  mounts: 'Explicit extra directories at identical absolute paths. Access defaults to read-only. The project root is already shared read-write.',
  examples: 'Documentation only: copy a value into its active field to enable it. Missing defaults/hints are restored and JSON is formatted when loaded or saved with pis --edit.',
};

export const PROJECT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'pis project configuration',
  type: 'object', additionalProperties: false,
  required: ['version', 'id', 'root', 'image', 'mounts', 'credentials', 'extensions'],
  properties: {
    $schema: { const: SCHEMA_REFERENCE },
    version: { const: 1 },
    id: { type: 'string', pattern: '^[a-z0-9]{5}$', description: 'Managed project identity; do not edit.' },
    name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' },
    root: { type: 'string', description: 'Canonical project root; use pis --relocate to change it.' },
    image: {
      type: 'object', additionalProperties: false,
      properties: {
        packages: { type: 'array', items: { type: 'string' }, default: [], description: 'Additional apt packages.' },
        extraInstructions: { type: 'array', items: { type: 'string' }, default: [], description: 'Trusted single-line RUN instructions, without continuation or build mounts.' },
      },
    },
    mounts: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, required: ['source'], properties: { source: { type: 'string' }, access: { enum: ['read-only', 'read-write'], default: 'read-only' } } } },
    credentials: {
      type: 'object', additionalProperties: false,
      description: HINTS.credentials,
      properties: {
        env: { type: 'array', items: { type: 'string' }, default: [], description: 'Names only, never secret values. Must be empty in proxy mode.' },
        proxy: {
          type: 'object', additionalProperties: false, required: ['provider'],
          properties: {
            provider: { enum: ['openai', 'berget', 'custom', 'openai-codex'], description: 'API-key or host OAuth proxy.' },
            keyEnv: { type: 'string', description: 'Host environment variable. Default: OPENAI_API_KEY or BERGET_API_KEY. Remove for a profile or Codex.' },
            profile: { enum: ['openai', 'berget', 'custom'], description: 'Host-managed profile matching provider, instead of keyEnv.' },
            models: { type: 'array', items: { type: 'string' }, default: [], description: 'Exact model allowlist; empty allows any model.' },
            maxRequests: { type: 'integer', minimum: 1, maximum: 100000, default: 1000 },
            maxConcurrent: { type: 'integer', minimum: 1, maximum: 64, default: 4 },
          },
          allOf: [{ if: { properties: { provider: { const: 'openai-codex' } } }, then: { not: { anyOf: [{ required: ['keyEnv'] }, { required: ['profile'] }] } } }, { if: { properties: { provider: { const: 'custom' } } }, then: { properties: { profile: { const: 'custom' } }, required: ['profile'], not: { required: ['keyEnv'] } } }, { not: { required: ['keyEnv', 'profile'] } }],
        },
      },
    },
    extensions: { type: 'array', uniqueItems: true, default: DEFAULT_EXTENSIONS, description: HINTS.extensions, items: { type: 'string', pattern: '^npm:' } },
    examples: { type: 'object', description: 'Inert examples; never executed or mounted.' },
    hints: { type: 'object', additionalProperties: false, description: 'Wrapper-generated documentation.', properties: Object.fromEntries(Object.entries(HINTS).map(([key, value]) => [key, { type: 'string', default: value }])) },
  },
};
