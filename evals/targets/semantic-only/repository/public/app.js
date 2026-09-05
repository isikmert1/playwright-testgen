const form = document.querySelector('#order-form');
const itemInput = document.querySelector('#item-name');
const quantityInput = document.querySelector('#item-quantity');
const orderStatus = document.querySelector('#order-status');
const ordersBody = document.querySelector('#orders');
const dialog = document.querySelector('#order-dialog');
const dialogDescription = document.querySelector('#dialog-description');

const orders = [{ item: 'Notebook', quantity: 2, status: 'Ready' }];

function renderOrders() {
  ordersBody.replaceChildren();
  for (const order of orders) {
    const row = document.createElement('tr');
    for (const value of [order.item, order.quantity, order.status]) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }

    const actions = document.createElement('td');
    const details = document.createElement('button');
    details.type = 'button';
    details.textContent = `View ${order.item} details`;
    details.addEventListener('click', () => {
      dialogDescription.textContent = `${order.quantity} × ${order.item} — ${order.status}`;
      dialog.showModal();
    });
    actions.append(details);
    row.append(actions);
    ordersBody.append(row);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const order = {
    item: itemInput.value.trim(),
    quantity: Number(quantityInput.value),
    status: 'Pending',
  };
  orders.push(order);
  renderOrders();
  form.reset();
  quantityInput.value = '1';
  orderStatus.textContent = `${order.item} added`;
});

renderOrders();
