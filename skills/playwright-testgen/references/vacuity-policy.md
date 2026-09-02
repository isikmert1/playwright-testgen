# Vacuity policy

A passing assertion is evidence only when the required behavior being absent
would make it fail. Apply this gate to every criterion before writing.

## Concrete evidence

- Assert a concrete return value, state, route, or side effect required by the
  criterion.
- An action completing without throwing is not an assertion. Neither is a
  container merely existing or being visible unless that is the required
  outcome.
- If the required outcome is empty, assert that exact empty state directly. Do
  not use an empty-to-empty comparison as evidence.

## Assertion loops

An assertion inside a loop needs a preceding assertion that proves the runtime
collection driving the loop contains at least one item. Guard the same
collection that controls iteration; checking a different collection does not
prove the loop ran.

```ts
expect(parsedFields.length).toBeGreaterThan(0);

for (const field of parsedFields) {
  expect(renderedFields).toContain(field);
}
```

Without the guard, an empty collection executes zero assertions and passes.

## Collection comparisons

Before using equality, subset, or pairwise comparison as evidence, prove both
sides are non-empty. Then make the concrete comparison.

```ts
expect(parsedFields).not.toHaveLength(0);
expect(previewFields).not.toHaveLength(0);
expect(previewFields).toEqual(parsedFields);
```

If either side can be empty without violating the comparison, the comparison
does not prove the criterion.
