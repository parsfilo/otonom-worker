import { describe, it, expect } from "vitest"
import { ModelSelector } from "../../harness/runtime/model-selector.js"

describe("Model Selector", () => {
  it("selects primary model for role", () => {
    const selector = new ModelSelector()
    const model = selector.selectModelForRole("builder-core")

    expect(model).toBeDefined()
    expect(typeof model).toBe("string")
    expect(model.length).toBeGreaterThan(0)
  })

  it("provides fallback model on STALLED or failure", () => {
    const selector = new ModelSelector()
    const primary = selector.selectModelForRole("builder-core")
    const fallback = selector.getFallbackModel("builder-core", [primary])

    expect(fallback).toBeDefined()
    expect(fallback).not.toBe(primary)
  })

  it("exhausts fallbacks gracefully", () => {
    const selector = new ModelSelector()
    const allModels = selector.getAllModelsForRole("builder-core")
    const fallback = selector.getFallbackModel("builder-core", allModels)

    expect(fallback).toBeNull()
  })

  it("records chosen model execution history", () => {
    const selector = new ModelSelector()
    selector.recordAttempt("lane-1", "builder-core", "model-a", "STALLED")
    selector.recordAttempt("lane-1", "builder-core", "model-b", "PASS")

    const history = selector.getLaneHistory("lane-1")
    expect(history.length).toBe(2)
    expect(history[0].status).toBe("STALLED")
    expect(history[1].status).toBe("PASS")
    expect(selector.getActiveModelForLane("lane-1")).toBe("model-b")
  })

  it("discovers free models using OpenCode CLI or default free catalog", () => {
    const freeModels = ModelSelector.discoverFreeModels()
    expect(Array.isArray(freeModels)).toBe(true)
    expect(freeModels.length).toBeGreaterThan(0)
    for (const model of freeModels) {
      expect(model).toMatch(/opencode\//)
      expect(model).toMatch(/free/)
    }
  })

  it("populates free models when autoDiscover is enabled", () => {
    const selector = new ModelSelector({ autoDiscover: true })
    const model = selector.selectModelForRole("builder-core")
    expect(model).toBeDefined()
    expect(model).toMatch(/opencode\//)
    expect(model).toMatch(/free/)
  })
})
