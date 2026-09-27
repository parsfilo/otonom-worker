import { VerificationRunner, VerificationProfile, VerificationResult } from "../../harness/verification/runner.js"

export class RunVerificationTool {
  private runner: VerificationRunner

  constructor(options?: { customProfiles?: Record<string, string>; cwd?: string }) {
    this.runner = new VerificationRunner(options)
  }

  public async execute(args: { profile: VerificationProfile }): Promise<VerificationResult> {
    return await this.runner.runProfile(args.profile)
  }
}
