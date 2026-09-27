import { describe, it, expect, vi } from "vitest"
import { ModelSelector } from "../../harness/runtime/model-selector.js"

describe("Model Selector", () => {
  it("selects primary model for role", () => {
    const selector = new ModelSelector()
    const model = selector.selectModelForRole("builder-core")

    expect(model).toBeDefined()
    expect(typeof model).toBe("string")
    expect(model.length).toBeGreaterThan(0)
    expect(model).toMatch(/^opencode\//)
    expect(model).toContain("-free")
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

  it("recognizes only opencode -free models as safe automatic choices", () => {
    expect(ModelSelector.isSafeFreeModel("opencode/nemotron-3.5-lightning-free")).toBe(true)
    expect(ModelSelector.isSafeFreeModel("opencode/gpt-5")).toBe(false)
    expect(ModelSelector.isSafeFreeModel("zen/qwen-2.5-coder-32b")).toBe(false)
  })

  it("populates free models when autoDiscover is enabled", () => {
    vi.spyOn(ModelSelector, "discoverFreeModels").mockReturnValue([
      "opencode/nemotron-3.5-lightning-free"
    ])
    const selector = new ModelSelector({ autoDiscover: true })
    const model = selector.selectModelForRole("builder-core")
    expect(model).toBeDefined()
    expect(model).toMatch(/opencode\//)
    expect(model).toMatch(/free/)
    vi.restoreAllMocks()
  })

  it("rejects stale zen model chains", () => {
    const selector = new ModelSelector({
      customChains: {
        "builder-core": ["zen/gemini-2.5-flash", "opencode/mimo-v2.6-flash-free"]
      },
      availableCatalog: ["zen/gemini-2.5-flash", "opencode/mimo-v2.6-flash-free"]
    })

    expect(selector.selectModelForRole("builder-core")).toBe("opencode/mimo-v2.6-flash-free")
  })

  it("rejects paid OpenCode models without -free", () => {
    const selector = new ModelSelector({
      customChains: {
        "builder-core": ["opencode/gpt-5", "opencode/space-bunny-free"]
      },
      availableCatalog: ["opencode/gpt-5", "opencode/space-bunny-free"]
    })

    expect(selector.selectModelForRole("builder-core")).toBe("opencode/space-bunny-free")
  })

  it("skips unavailable candidates and selects discovered free candidate", () => {
    const selector = new ModelSelector({
      customChains: {
        "builder-core": [
          "opencode/nemotron-3.5-lightning-free",
          "opencode/longcat-2.5-preview-free"
        ]
      },
      availableCatalog: ["opencode/longcat-2.5-preview-free"]
    })

    expect(selector.selectModelForRole("builder-core")).toBe("opencode/longcat-2.5-preview-free")
  })

  it("fails closed when safe free catalog is empty", () => {
    const selector = new ModelSelector({
      customChains: {
        "builder-core": ["opencode/gpt-5", "zen/qwen-2.5-coder-32b"]
      },
      availableCatalog: ["opencode/gpt-5", "zen/qwen-2.5-coder-32b"]
    })

    expect(selector.getFallbackModel("builder-core", [])).toBeNull()
    expect(() => selector.selectModelForRole("builder-core")).toThrow(/FREE_MODEL_UNAVAILABLE/)
  })
})
