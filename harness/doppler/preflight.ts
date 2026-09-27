import { TrustedDopplerClient } from "./client.js"

export function main() {
  const forceSingleAgent = process.env.SWARM_FORCE_SINGLE !== "false"
  const client = new TrustedDopplerClient()

  try {
    const result = client.runPreflight({ forceSingleAgent })
    client.logPreflightSummary(result)

    if (!result.valid) {
      process.exit(1)
    }
  } catch (err: any) {
    console.error(`doppler_preflight: FAIL`)
    console.error(`[Doppler Preflight Fatal] ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith("preflight.ts")) {
  main()
}
