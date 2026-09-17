/**
 * Does a plugin declaring `platforms` / `arch` run on the CURRENT host?
 *
 * WHY TWO AXES AND NOT ONE
 *   A single six-valued enum (`win32-x64`, `darwin-arm64`, …) mixes two
 *   independent things and forces every manifest to restate them together. Two
 *   coarse fields express the same set while keeping each axis meaningful:
 *
 *     platforms: ["windows", "linux"]     arch: ["x64"]
 *
 *   The check exists because the failure it prevents is silent until load time:
 *   an x64-only native library on arm64 Windows installs fine and then throws
 *   when the plugin is loaded. Declaring only `platforms: ["windows"]` would
 *   call that compatible.
 *
 * PURE JS PLUGINS DECLARE NOTHING
 *   Omitting both means "runs anywhere the host does", which is correct for the
 *   common case — a plugin with no native code is architecture-independent.
 */

/** Architectures we accept in a manifest. Ours, not Node's, so a rename cannot break manifests. */
export const PLUGIN_ARCHES = ["x64", "arm64"] as const
export type PluginArch = (typeof PLUGIN_ARCHES)[number]

/** Operating systems we accept in a manifest. */
export const PLUGIN_PLATFORMS = ["windows", "linux", "macos"] as const
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number]

/**
 * Map a Node `process.platform` to a manifest platform.
 *
 * Returns undefined for platforms we do not ship a host for (freebsd, aix, …):
 * a plugin cannot declare them, and the host cannot run there, so "unknown"
 * must not silently be treated as a match.
 */
export function toPluginPlatform(nodePlatform: string): PluginPlatform | undefined {
  if (nodePlatform === "win32") return "windows"
  if (nodePlatform === "linux") return "linux"
  if (nodePlatform === "darwin") return "macos"
  return undefined
}

/** Map a Node `process.arch` to a manifest arch, or undefined when unsupported. */
export function toPluginArch(nodeArch: string): PluginArch | undefined {
  return (PLUGIN_ARCHES as readonly string[]).includes(nodeArch) ? (nodeArch as PluginArch) : undefined
}

export type PlatformVerdict =
  | { compatible: true; reason: "no-declaration" | "declared" }
  | { compatible: false; reason: "unsupported-host" | "platform" | "arch" }

/**
 * Check a declaration against a host.
 *
 * An unsupported HOST (one we do not ship for) is reported as incompatible
 * rather than assumed to match: the host cannot legitimately run there, so
 * treating it as compatible would hide a packaging mistake.
 */
export function checkPlatformCompatibility(
  declaration: { platforms?: readonly string[]; arch?: readonly string[] },
  host: { platform: string; arch: string },
): PlatformVerdict {
  const targetPlatform = toPluginPlatform(host.platform)
  const targetArch = toPluginArch(host.arch)
  if (!targetPlatform || !targetArch) return { compatible: false, reason: "unsupported-host" }

  // No declaration = pure JS = runs anywhere. By far the common case.
  if (!declaration.platforms && !declaration.arch) {
    return { compatible: true, reason: "no-declaration" }
  }

  if (declaration.platforms && !declaration.platforms.includes(targetPlatform)) {
    return { compatible: false, reason: "platform" }
  }
  if (declaration.arch && !declaration.arch.includes(targetArch)) {
    return { compatible: false, reason: "arch" }
  }
  return { compatible: true, reason: "declared" }
}
