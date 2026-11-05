import { test, expect } from '@playwright/test';

// Synthetic public-form input; this fixture never signs in.
const control = process.env.TESTGEN_RWA_CONTROL ?? 'strong';

test('requires a username before sign in', async ({ page }) => {
  if (!['strong', 'weak', 'unrelated'].includes(control))
    throw new Error('Unknown RWA control');
  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('');
  await page
    .getByLabel('Password', { exact: true })
    .fill('synthetic-form-input');
  await page.getByRole('textbox', { name: 'Username', exact: true }).focus();
  await page.getByLabel('Password', { exact: true }).focus();
  await test.step('verify required username', async () => {
    await expect(
      page.getByRole('button', { name: 'Sign In', exact: true }),
    ).toBeVisible();
    if (control === 'strong') {
      await expect(
        page.getByText('Username is required', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Sign In', exact: true }),
      ).toBeDisabled();
    }
  });
  if (control === 'unrelated')
    await test.step('check outside the approved criterion', async () => {
      await expect(
        page.getByText('Username is required', { exact: true }),
      ).toBeVisible();
    });
});
