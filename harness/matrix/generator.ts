import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import { validateTask } from "../validation/schema-validator.js"

export interface TaskRecord {
  id: string
  title: string
  role: string
  source_repository: string
  base_sha: string
  objectives: string[]
  allowed_write_paths: string[]
  forbidden_write_paths?: string[]
  acceptance_criteria: string[]
  verification_profile: string
  timeout_minutes?: number
  risk_classification: string
}

export interface MatrixItem {
  lane: string
  role: string
  base_sha: string
  verification_profile: string
  timeout_minutes: number
  risk_classification: string
}

export interface MatrixOutput {
  maxParallel: number
  matrix: {
    include: MatrixItem[]
  }
}

export interface MatrixGenerationInput {
  tasks: unknown[]
  maxParallel: number
  laneFilter?: string
}

export function generateMatrix(input: MatrixGenerationInput): MatrixOutput {
  const maxParallel = Number(input.maxParallel)

  if (isNaN(maxParallel) || maxParallel < 1) {
    throw new Error("max_parallel must be an integer >= 1")
  }

  if (maxParallel > 20) {
    throw new Error(`max_parallel cannot exceed 20 (requested: ${maxParallel})`)
  }

  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error("No tasks provided for matrix generation")
  }

  const seenLanes = new Set<string>()
  const validTasks: TaskRecord[] = []

  for (const rawTask of input.tasks) {
    const valResult = validateTask(rawTask)
    if (!valResult.valid) {
      throw new Error(`Task schema validation failed: ${valResult.errors?.join("; ")}`)
    }

    const task = rawTask as TaskRecord
    if (seenLanes.has(task.id)) {
      throw new Error(`Duplicate lane ID detected: ${task.id}`)
    }
    seenLanes.add(task.id)

    if (input.laneFilter) {
      if (task.id !== input.laneFilter) {
        continue
      }
    }

    validTasks.push(task)
  }

  if (validTasks.length === 0) {
    throw new Error(`No tasks matched filter: ${input.laneFilter}`)
  }

  const matrixItems: MatrixItem[] = validTasks.map((t) => ({
    lane: t.id,
    role: t.role,
    base_sha: t.base_sha,
    verification_profile: t.verification_profile,
    timeout_minutes: t.timeout_minutes ?? 30,
    risk_classification: t.risk_classification
  }))

  return {
    maxParallel,
    matrix: {
      include: matrixItems
    }
  }
}

export function loadManifestFile(manifestPath: string, rootDir: string = process.cwd()): unknown[] {
  if (!manifestPath || typeof manifestPath !== "string") {
    throw new Error("Invalid manifest path: path must be a non-empty string")
  }

  // Enforce approved extensions
  const ext = path.extname(manifestPath).toLowerCase()
  if (![".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error(`Invalid manifest extension: '${ext}'. Only .yaml, .yml, and .json are permitted.`)
  }

  // Check for path traversal attempts
  const normalized = manifestPath.replace(/\\/g, "/")
  if (normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error(`Path traversal detected in manifest path: ${manifestPath}`)
  }

  const resolved = path.resolve(rootDir, manifestPath)
  if (!resolved.startsWith(path.resolve(rootDir))) {
    throw new Error(`Manifest path escapes approved directory: ${manifestPath}`)
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Manifest file does not exist: ${resolved}`)
  }

  const content = fs.readFileSync(resolved, "utf-8")
  if (ext === ".json") {
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : parsed.tasks || [parsed]
  } else {
    const parsed = yaml.parse(content)
    return Array.isArray(parsed) ? parsed : parsed.tasks || [parsed]
  }
}

// CLI handler for workflow step
if (process.argv[1] && process.argv[1].endsWith("generator.ts")) {
  const manifestFile = process.argv[2]
  const maxParallel = parseInt(process.argv[3] || "5", 10)
  const laneFilter = process.argv[4]

  try {
    const tasks = loadManifestFile(manifestFile)
    const result = generateMatrix({
      tasks,
      maxParallel,
      laneFilter: laneFilter && laneFilter.trim() !== "" ? laneFilter : undefined
    })

    console.log(JSON.stringify(result.matrix))
  } catch (err: any) {
    console.error(`Matrix generation error: ${err.message}`)
    process.exit(1)
  }
}
