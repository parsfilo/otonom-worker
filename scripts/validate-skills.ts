import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import { containsSensitiveData } from "../harness/logging/sanitizer.js"

export interface SkillValidationResult {
  valid: boolean
  errors: string[]
  skillCount: number
}

export function validateSingleSkill(dirName: string, content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check Frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) {
    errors.push(`[${dirName}] Missing valid YAML frontmatter delimiter (---)`)
    return { valid: false, errors }
  }

  let fm: any = {}
  try {
    fm = yaml.parse(fmMatch[1])
  } catch (err: any) {
    errors.push(`[${dirName}] Failed to parse YAML frontmatter: ${err.message}`)
    return { valid: false, errors }
  }

  if (!fm || typeof fm !== "object") {
    errors.push(`[${dirName}] Frontmatter must be a YAML object`)
    return { valid: false, errors }
  }

  if (!fm.name || typeof fm.name !== "string") {
    errors.push(`[${dirName}] Missing or invalid 'name' in frontmatter`)
  } else if (!/^[a-z0-9-]+$/i.test(fm.name)) {
    errors.push(`[${dirName}] 'name' contains invalid characters (allowed: a-z, 0-9, hyphen)`)
  }

  if (!fm.description || typeof fm.description !== "string") {
    errors.push(`[${dirName}] Missing or invalid 'description' in frontmatter`)
  }

  // Check forbidden force-load links
  if (/@skills\//i.test(content) || /@.*\/SKILL\.md/i.test(content)) {
    errors.push(`[${dirName}] Contains forbidden '@' force-load skill link pattern`)
  }

  // Check for leaked secrets
  if (containsSensitiveData(content)) {
    errors.push(`[${dirName}] Contains secret material or sensitive token`)
  }

  // Check bounded size
  if (content.length > 50000) {
    errors.push(`[${dirName}] SKILL.md exceeds bounded size limit (>50k chars)`)
  }

  return { valid: errors.length === 0, errors }
}

export async function validateSkillsDirectory(skillsDir: string): Promise<SkillValidationResult> {
  const errors: string[] = []
  const seenNames = new Set<string>()

  if (!fs.existsSync(skillsDir)) {
    return { valid: false, errors: [`Skills directory not found: ${skillsDir}`], skillCount: 0 }
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  const skillDirs = entries.filter((e) => e.isDirectory())

  for (const dir of skillDirs) {
    const skillPath = path.join(skillsDir, dir.name, "SKILL.md")
    if (!fs.existsSync(skillPath)) {
      errors.push(`Skill directory missing SKILL.md: ${dir.name}`)
      continue
    }

    const content = fs.readFileSync(skillPath, "utf-8")
    const check = validateSingleSkill(dir.name, content)
    if (!check.valid) {
      errors.push(...check.errors)
    }

    if (seenNames.has(dir.name)) {
      errors.push(`Duplicate skill name detected: ${dir.name}`)
    }
    seenNames.add(dir.name)
  }

  return {
    valid: errors.length === 0,
    errors,
    skillCount: skillDirs.length
  }
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("validate-skills.ts")) {
  const targetDir = process.argv[2] || path.resolve(process.cwd(), ".agents/skills")
  console.log(`Validating skills in: ${targetDir}`)

  validateSkillsDirectory(targetDir).then((res) => {
    if (!res.valid) {
      console.error(`Skill validation failed with ${res.errors.length} errors:`)
      res.errors.forEach((e) => console.error(`  - ${e}`))
      process.exit(1)
    } else {
      console.log(`✓ All ${res.skillCount} skills validated successfully.`)
      process.exit(0)
    }
  })
}
