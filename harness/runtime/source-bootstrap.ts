import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export interface SourceBootstrapOptions {
  repoUrl: string
  cloneToken?: string
  targetSha: string
  destinationDir: string
}

export interface SourceBootstrapResult {
  success: boolean
  checkedOutSha: string
  error?: string
}

export class SourceBootstrapper {
  private repoUrl: string
  private cloneToken?: string
  private targetSha: string
  private destinationDir: string

  constructor(options: SourceBootstrapOptions) {
    this.repoUrl = options.repoUrl
    this.cloneToken = options.cloneToken
    this.targetSha = options.targetSha
    this.destinationDir = path.resolve(options.destinationDir)
  }

  public async bootstrap(): Promise<SourceBootstrapResult> {
    try {
      fs.mkdirSync(this.destinationDir, { recursive: true })

      // 1. Initialize local repository
      execFileSync("git", ["init"], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })

      // 2. Set origin remote
      execFileSync("git", ["remote", "add", "origin", this.repoUrl], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })

      // 3. Build fetch arguments with transient headers (token never persisted in config)
      const fetchArgs: string[] = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="]
      if (this.cloneToken && !this.repoUrl.startsWith("/") && !this.repoUrl.startsWith("\\") && !/^[a-zA-Z]:/.test(this.repoUrl)) {
        fetchArgs.push("-c", `http.extraHeader=Authorization: token ${this.cloneToken}`)
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

      // 4. Checkout exact SHA in detached HEAD mode
      try {
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", this.targetSha], {
          cwd: this.destinationDir,
          stdio: "ignore"
        })
      } catch (checkoutErr: any) {
        throw new Error(`Failed to checkout SHA ${this.targetSha}: ${checkoutErr.message}`)
      }

      // 5. Authoritative verification of checked out SHA
      const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.destinationDir,
        encoding: "utf-8"
      }).trim()

      if (checkedOutSha !== this.targetSha) {
        throw new Error(`SHA mismatch: expected ${this.targetSha} but checked out ${checkedOutSha}`)
      }

      // 6. Enforce defensive workspace configurations
      execFileSync("git", ["config", "--local", "core.hooksPath", "/dev/null"], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })
      execFileSync("git", ["config", "--local", "credential.helper", ""], {
        cwd: this.destinationDir,
        stdio: "ignore"
      })

      // 7. Verify .git/config contains NO leaked token
      const gitConfigFile = path.join(this.destinationDir, ".git", "config")
      if (fs.existsSync(gitConfigFile) && this.cloneToken) {
        const configText = fs.readFileSync(gitConfigFile, "utf-8")
        if (configText.includes(this.cloneToken)) {
          throw new Error("Security violation: clone token was leaked into .git/config")
        }
      }

      return {
        success: true,
        checkedOutSha
      }
    } catch (err: any) {
      return {
        success: false,
        checkedOutSha: "",
        error: err.message
      }
    }
  }
}
