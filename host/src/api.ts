export const HOST_VERSION = "0.0.1"
export const HOST_RESTART_EXIT = 51

export type HostWsAPI = {
  ping(): Promise<string>
  getVersion(): Promise<string>
}

export const hostWsAPI: HostWsAPI = {
  async ping() {
    return "pong"
  },
  async getVersion() {
    return HOST_VERSION
  },
}
