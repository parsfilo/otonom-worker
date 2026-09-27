import { describe, it, expect } from "vitest"
import path from "node:path"
import { validateSkillsDirectory, validateSingleSkill } from "../../scripts/validate-skills.js"

describe("Skill Validator", () => {
  it("validates all skills currently in .agents/skills", async () => {
    const skillsDir = path.resolve(process.cwd(), ".agents/skills")
    const result = await validateSkillsDirectory(skillsDir)

    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.skillCount).toBeGreaterThanOrEqual(25) // 6 superpowers + 4 trail of bits + 15 otonom = 25
  })

  it("rejects skill with invalid frontmatter or forbidden force-load links", () => {
    const invalidSkillContent = `---
name: bad-skill
description: Does something bad
---
# Bad Skill
See @skills/other/SKILL.md for details.
`
    const check = validateSingleSkill("bad-skill", invalidSkillContent)
    expect(check.valid).toBe(false)
    expect(check.errors.some((e) => e.includes("forbidden '@' force-load"))).toBe(true)
  })

  it("rejects skill with secret material", () => {
    const leakSkillContent = `---
name: leak-skill
description: Use when needing a token
---
# Token Skill
Use ghp_1234567890abcdefghijklmnopqrstuvwxyzAB
`
    const check = validateSingleSkill("leak-skill", leakSkillContent)
    expect(check.valid).toBe(false)
    expect(check.errors.some((e) => e.includes("secret material"))).toBe(true)
  })
})
