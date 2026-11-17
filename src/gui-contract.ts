import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"
import type { Attachment, FieldBoard, RoomSnapshot } from "./types.ts"

export { ArenaRpc } from "./room-rpc.ts"

const WatchInput = Schema.Struct({
  serverID: Schema.String,
  sessionID: Schema.String,
})
const SendInput = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.String,
  to: Schema.Unknown,
  private: Schema.Boolean,
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        mime: Schema.String,
        data: Schema.String,
      }),
    ),
  ),
})

export const ArenaBridge = Ipc.define({
  id: "arena.bridge",
  state: Schema.Unknown,
  methods: {
    watch: { input: WatchInput, output: Schema.Unknown },
    send: { input: SendInput, output: Schema.Unknown },
  },
})

export interface BridgeState {
  ok: boolean
  room?: RoomSnapshot
  field?: FieldBoard
  error?: string
}

export interface WatchRequest {
  serverID: string
  sessionID: string
}

export interface SendRequest {
  sessionID: string
  text: string
  to?: string[] | "all"
  private?: boolean
  attachments?: Attachment[]
}
