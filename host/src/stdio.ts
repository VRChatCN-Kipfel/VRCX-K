import { RPCChannel } from "kkrpc"
import {
  stdioJsonTransport,
  type ReadableLike,
  type WritableLike,
} from "kkrpc/stdio"
import { HOST_RESTART_EXIT, hostWsAPI } from "./api"
import type { HostWsReady } from "./ws"

export type HostStdioAPI = {
  ping(): Promise<string>
  stop(): Promise<boolean>
  restart(): Promise<boolean>
}

export type ShellStdioAPI = {
  ready(info: HostWsReady): Promise<void>
}

class ReadableStreamLike implements ReadableLike {
  private listeners = new Set<(chunk: Uint8Array | string) => void>()

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.pump(stream)
  }

  on(event: "data", listener: (chunk: Uint8Array | string) => void) {
    if (event === "data") this.listeners.add(listener)
    return this
  }

  off(event: "data", listener: (chunk: Uint8Array | string) => void) {
    if (event === "data") this.listeners.delete(listener)
    return this
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) return
        for (const listener of this.listeners) listener(result.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
}

function bunWritable(): WritableLike {
  return {
    write(chunk, callback) {
      void Bun.write(Bun.stdout, chunk).then(
        () => callback?.(),
        (error) => callback?.(error instanceof Error ? error : new Error(String(error))),
      )
    },
  }
}

function bunStdioTransport() {
  return stdioJsonTransport({
    readable: new ReadableStreamLike(Bun.stdin.stream()),
    writable: bunWritable(),
    lifecycle: process.stdin,
  })
}

export function connectShellStdio() {
  const channel = new RPCChannel<HostStdioAPI, ShellStdioAPI>(bunStdioTransport(), {
    expose: {
      ping: () => hostWsAPI.ping(),
      stop: async () => {
        setTimeout(() => process.exit(0), 10)
        return true
      },
      restart: async () => {
        setTimeout(() => process.exit(HOST_RESTART_EXIT), 10)
        return true
      },
    },
  })
  return channel.getAPI()
}
