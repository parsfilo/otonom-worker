import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export interface SourceBootstrapOptions {
  repoUrl: string
  cloneToken?: string
  targetSha: string
  destinationDir: string
  baseBranch?: string
}

export interface SourceBootstrapResult {
  success: boolean
  checkedOutSha: string
  baseBranch: string
  error?: string
}

export class SourceBootstrapper {
  private repoUrl: string
  private cloneToken?: string
  private targetSha: string
  private destinationDir: string
  private baseBranch: string

  constructor(options: SourceBootstrapOptions) {
    this.repoUrl = options.repoUrl
    this.cloneToken = options.cloneToken
    this.targetSha = options.targetSha
    this.destinationDir = path.resolve(options.destinationDir)
    this.baseBranch = options.baseBranch || "main"
  }

  private isRemoteUrl(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://")
  }

  public async bootstrap(): Promise<SourceBootstrapResult> {
    try {
      fs.mkdirSync(this.destinationDir, { recursive: true })

      // 1. Resolve exact target commit SHA if ref or placeholder provided
      let effectiveSha = this.targetSha
      let resolvedBranch = this.baseBranch
      const isReal40Hex = /^[0-9a-f]{40}$/i.test(this.targetSha) && !/^0{40}$/.test(this.targetSha)

      if (!isReal40Hex) {
        resolvedBranch = this.targetSha && this.targetSha !== "0000000000000000000000000000000000000000"
          ? this.targetSha
          : this.baseBranch

        const lsArgs = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="]
        if (this.cloneToken && this.isRemoteUrl(this.repoUrl)) {
          const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.cloneToken}`).toString("base64")}`
          lsArgs.push("-c", `http.https://github.com/.extraheader=${authHeader}`)
        }
        lsArgs.push("ls-remote", this.repoUrl, `refs/heads/${resolvedBranch}`, resolvedBranch)

        try {
          const lsOutput = execFileSync("git", lsArgs, {
            encoding: "utf-8",
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: ""
            }
          }).trim()

          const firstLine = lsOutput.split("\n")[0]?.trim()
          const matchedSha = firstLine ? firstLine.split(/\s+/)[0] : ""
          if (matchedSha && /^[0-9a-f]{40}$/i.test(matchedSha)) {
            effectiveSha = matchedSha
          } else {
            throw new Error(`Failed to resolve commit SHA for ref '${resolvedBranch}' in remote`)
          }
        } catch (lsErr: any) {
          throw new Error(`Failed to query remote SHA for '${resolvedBranch}': ${lsErr.message}`)
        }
      }

      // 2. Initialize local repository if not already initialized
      if (!fs.existsSync(path.join(this.destinationDir, ".git"))) {
        execFileSync("git", ["init"], {
          cwd: this.destinationDir,
          stdio: "ignore"
        })
      }

      // 3. Set origin remote
      try {
        execFileSync("git", ["remote", "remove", "origin"], {
          cwd: this.destinationDir,
          stdio: "ignore"
        })
      } catch {}

      execFileSync("git", ["remote", "add", "origin", this.repoUrl], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })

      // 4. Build fetch arguments with transient headers (token never persisted in config)
      const fetchArgs: string[] = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="]
      if (this.cloneToken && this.isRemoteUrl(this.repoUrl)) {
        const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.cloneToken}`).toString("base64")}`
        fetchArgs.push("-c", `http.https://github.com/.extraheader=${authHeader}`)
      }
      fetchArgs.push("fetch", "origin")

      try {
        execFileSync("git", fetchArgs, {
          cwd: this.destinationDir,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: ""
          },
          stdio: "ignore"
        })
      } catch (fetchErr: any) {
        throw new Error(`Failed to fetch from remote: ${fetchErr.message}`)
      }

      // 5. Checkout exact SHA in detached HEAD mode
      try {
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", effectiveSha], {
          cwd: this.destinationDir,
          stdio: "ignore"
        })
      } catch (checkoutErr: any) {
        throw new Error(`Failed to checkout SHA ${effectiveSha}: ${checkoutErr.message}`)
      }

      // 6. Authoritative verification of checked out SHA
      const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.destinationDir,
        encoding: "utf-8"
      }).trim()

      if (checkedOutSha !== effectiveSha) {
        throw new Error(`SHA mismatch: expected ${effectiveSha} but checked out ${checkedOutSha}`)
      }

      // 7. Enforce defensive workspace configurations
      execFileSync("git", ["config", "--local", "core.hooksPath", "/dev/null"], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })
      execFileSync("git", ["config", "--local", "credential.helper", ""], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })

      // 8. Verify .git/config contains NO leaked token
      const gitConfigFile = path.join(this.destinationDir, ".git", "config")
      if (fs.existsSync(gitConfigFile) && this.cloneToken) {
        const configText = fs.readFileSync(gitConfigFile, "utf-8")
        if (configText.includes(this.cloneToken)) {
          throw new Error("Security violation: clone token was leaked into .git/config")
        }
      }

      console.log(`target_clone: PASS`)
      console.log(`target_base_branch: ${resolvedBranch}`)
      console.log(`target_sha: ${checkedOutSha}`)

      return {
        success: true,
        checkedOutSha,
        baseBranch: resolvedBranch
      }
    } catch (err: any) {
      return {
        success: false,
        checkedOutSha: "",
        baseBranch: this.baseBranch,
        error: err.message
      }
    }
  }
}
