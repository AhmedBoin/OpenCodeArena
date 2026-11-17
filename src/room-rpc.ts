const anyObject = { type: "object", additionalProperties: true } as const
const snapshotInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const
const sendInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    text: { type: "string" },
    to: {},
    private: { type: "boolean" },
    attachments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          mime: { type: "string" },
          data: { type: "string" },
        },
        required: ["name", "mime", "data"],
        additionalProperties: false,
      },
    },
  },
  required: ["sessionID", "text"],
  additionalProperties: false,
} as const

/**
 * Portable RPC definition shared by the Arena server and the desktop GUI.
 * It uses JSON Schema and no runtime SDK import, so the server half does not
 * pull the experimental GUI module into the server process.
 */
const waitInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    after: { type: "string" },
    timeoutMs: { type: "number" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

export const ArenaRpc = {
  id: "arena.room",
  methods: {
    snapshot: { input: snapshotInput, output: anyObject },
    send: { input: sendInput, output: anyObject },
    board: { input: snapshotInput, output: anyObject },
    wait: { input: waitInput, output: anyObject },
  },
  events: {},
} as const
