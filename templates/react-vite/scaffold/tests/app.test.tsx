import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { App } from "@/app"

afterEach(cleanup)

test("the home page shows the heading and the main action", () => {
  render(<App />)
  expect(screen.getByRole("heading", { name: "App" })).toBeTruthy()
  expect(screen.getByRole("button", { name: /get started/i })).toBeTruthy()
})
