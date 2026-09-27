import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const schemasDir = path.resolve(__dirname, "../../schemas")

const ajv = new (Ajv2020 as any)({
  allErrors: true,
  strict: false,
  validateFormats: true
})
// @ts-expect-error ajv-formats typing
addFormats(ajv)

function loadSchema(filename: string) {
  const filepath = path.join(schemasDir, filename)
  const raw = fs.readFileSync(filepath, "utf-8")
  return JSON.parse(raw)
}

const taskSchema = loadSchema("task.schema.json")
const resultSchema = loadSchema("result.schema.json")
const findingSchema = loadSchema("finding.schema.json")
const crossLaneSchema = loadSchema("cross-lane-request.schema.json")
const evidenceSchema = loadSchema("evidence.schema.json")

const validateTaskFn = ajv.compile(taskSchema)
const validateResultFn = ajv.compile(resultSchema)
const validateFindingFn = ajv.compile(findingSchema)
const validateCrossLaneFn = ajv.compile(crossLaneSchema)
const validateEvidenceFn = ajv.compile(evidenceSchema)

export interface ValidationOutput {
  valid: boolean
  errors?: string[]
}

function formatErrors(errors: any): string[] {
  if (!errors) return []
  return errors.map((err: any) => `${err.instancePath || "/"}: ${err.message}`)
}

export function validateTask(data: unknown): ValidationOutput {
  const valid = validateTaskFn(data) as boolean
  return {
    valid,
    errors: valid ? undefined : formatErrors(validateTaskFn.errors)
  }
}

export function validateResult(data: unknown): ValidationOutput {
  const valid = validateResultFn(data) as boolean
  return {
    valid,
    errors: valid ? undefined : formatErrors(validateResultFn.errors)
  }
}

export function validateFinding(data: unknown): ValidationOutput {
  const valid = validateFindingFn(data) as boolean
  return {
    valid,
    errors: valid ? undefined : formatErrors(validateFindingFn.errors)
  }
}

export function validateCrossLaneRequest(data: unknown): ValidationOutput {
  const valid = validateCrossLaneFn(data) as boolean
  return {
    valid,
    errors: valid ? undefined : formatErrors(validateCrossLaneFn.errors)
  }
}

export function validateEvidence(data: unknown): ValidationOutput {
  const valid = validateEvidenceFn(data) as boolean
  return {
    valid,
    errors: valid ? undefined : formatErrors(validateEvidenceFn.errors)
  }
}
