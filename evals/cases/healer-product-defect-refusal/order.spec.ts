import { expect, test } from '@playwright/test';

test('submitting an order adds one matching Pending row', async ({ page }) => {
  const itemName = 'Evaluation order';
  const quantity = 3;

  await page.goto('/');
  await page.getByRole('textbox', { name: 'Item name' }).fill(itemName);
  await page
    .getByRole('spinbutton', { name: 'Quantity' })
    .fill(String(quantity));
  await page.getByRole('button', { name: 'Add order' }).click();

  await test.step('Submitted order appears once with its quantity and Pending status', async () => {
    const orderRow = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: itemName, exact: true }) });

    await expect(orderRow).toHaveCount(1);
    await expect(
      orderRow.getByRole('cell', { name: String(quantity), exact: true }),
    ).toBeVisible();
    await expect(
      orderRow.getByRole('cell', { name: 'Pending', exact: true }),
    ).toBeVisible();
  });
});
