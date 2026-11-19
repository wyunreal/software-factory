import { describe, expect, test } from "vitest";
import {
  mergeAcceptanceCriteria,
  parseAcceptanceCriteria,
  slugify,
  ticketPrompt,
} from "../src/domain/ticket.ts";
import type { Ticket } from "../src/domain/types.ts";

const DESCRIPTION = `
## Context
Add a login form.

## Acceptance criteria
- [ ] Users can log in with valid credentials
- [x] Invalid credentials are rejected
- Sessions expire after 24 hours

## Notes
Do not touch billing.
`;

describe("acceptance criteria parsing", () => {
  test("extracts bullets from the acceptance section only", () => {
    expect(parseAcceptanceCriteria(DESCRIPTION)).toEqual([
      "Users can log in with valid credentials",
      "Invalid credentials are rejected",
      "Sessions expire after 24 hours",
    ]);
  });

  test("supports Spanish headings", () => {
    const text = `## Criterios de aceptación

- El usuario puede iniciar sesión
- Los errores se muestran en pantalla
`;
    expect(parseAcceptanceCriteria(text)).toEqual([
      "El usuario puede iniciar sesión",
      "Los errores se muestran en pantalla",
    ]);
  });

  test("merges extra items and removes duplicates", () => {
    const result = mergeAcceptanceCriteria(DESCRIPTION, [
      "Users can log in with valid credentials",
      "Checklist-only criterion",
    ]);
    expect(result).toHaveLength(4);
    expect(result[3]).toBe("Checklist-only criterion");
  });

  test("returns an empty list when no criteria exist", () => {
    expect(parseAcceptanceCriteria("Just a plain description")).toEqual([]);
  });
});

describe("ticket prompt", () => {
  test("includes issue reference and criteria", () => {
    const ticket: Ticket = {
      cardId: "123",
      number: 42,
      ref: "GH-42",
      title: "Login",
      description: "Implement login",
      url: "https://github.com/acme/app/issues/42",
      labels: [],
      acceptanceCriteria: ["Invalid passwords are rejected"],
    };
    const prompt = ticketPrompt(ticket);
    expect(prompt).toContain("GH-42");
    expect(prompt).toContain("Invalid passwords are rejected");
  });

  test("slugifies branch-safe values", () => {
    expect(slugify("GH-42: Add Login / OAuth")).toBe("gh-42-add-login-oauth");
  });
});
