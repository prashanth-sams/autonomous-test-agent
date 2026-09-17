import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A deliberately buggy shop used as the agent's evaluation target.
 *
 * Seeded defects (the agent should find these without being told):
 *   1. /products throws an uncaught JavaScript exception on load
 *   2. "Apply coupon" on /checkout is wired to nothing
 *   3. GET /api/inventory returns HTTP 500
 *   4. The "Help" link points at a 404
 *   5. Placing an order is not idempotent: each click creates another order
 *   6. A declined card still creates an order
 */

interface Order {
  id: number;
  card: string;
  declined: boolean;
}

const orders: Order[] = [];
let nextOrderId = 1001;

const page = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f7f8fa;color:#14181f}
 nav{background:#14181f;padding:12px 20px}
 nav a{color:#fff;margin-right:16px;text-decoration:none}
 main{max-width:640px;margin:32px auto;background:#fff;padding:24px;border-radius:12px;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
 label{display:block;margin:12px 0 4px;font-size:.9rem;color:#4a5260}
 input,select{width:100%;padding:8px 10px;border:1px solid #cdd3dd;border-radius:6px;font-size:1rem}
 button{margin-top:16px;margin-right:8px;padding:9px 16px;border:0;border-radius:6px;
        background:#2f6feb;color:#fff;font-size:1rem;cursor:pointer}
 button.secondary{background:#e7eaf0;color:#14181f}
 .error{color:#b3261e;margin-top:12px}
</style></head>
<body>
<nav>
  <a href="/">Home</a><a href="/products">Products</a><a href="/cart">Cart</a>
  <a href="/checkout">Checkout</a><a href="/profile">Profile</a><a href="/help">Help</a>
</nav>
<main>${body}</main>
<script>${script}</script>
</body></html>`;

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => void> = {
  '/': (_req, res) => {
    send(res, 200, page('Demo Shop', `
      <h1>Demo Shop</h1>
      <p>An intentionally buggy shop for exercising the autonomous testing agent.</p>
      <p><a href="/products">Browse products</a></p>`));
  },

  '/products': (_req, res) => {
    send(res, 200, page('Products', `
      <h1>Products</h1>
      <ul>
        <li>Blue Widget — $19.00 <button data-testid="add-widget">Add to cart</button></li>
        <li>Red Gadget — $29.00 <button data-testid="add-gadget">Add to cart</button></li>
      </ul>
      <p><a href="/cart">Go to cart</a></p>`,
      // Defect 1 + 3: an uncaught exception and a failing inventory call.
      `document.querySelectorAll('button[data-testid^=add]').forEach(function (b) {
         b.addEventListener('click', function () { location.href = '/cart'; });
       });
       fetch('/api/inventory').then(function (r) { return r.json(); });
       window.__cart.total = 0;`));
  },

  '/cart': (_req, res) => {
    send(res, 200, page('Cart', `
      <h1>Your cart</h1>
      <p>1 x Blue Widget — $19.00</p>
      <p><a href="/checkout">Proceed to checkout</a></p>`));
  },

  '/checkout': (_req, res) => {
    send(res, 200, page('Checkout', `
      <h1>Checkout</h1>
      <form id="checkout" onsubmit="return false">
        <label for="name">Full name</label>
        <input id="name" name="name" required>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required>
        <label for="card">Card number</label>
        <input id="card" name="card" required>
        <label for="coupon">Coupon code</label>
        <input id="coupon" name="coupon">
        <button type="button" class="secondary" data-testid="apply-coupon">Apply coupon</button>
        <button type="button" data-testid="place-order">Place order</button>
      </form>
      <p id="status"></p>`,
      // Defect 2: "Apply coupon" has no handler at all.
      // Defect 5/6: every click posts a new order, declined cards included.
      `document.querySelector('[data-testid=place-order]').addEventListener('click', function () {
         var card = document.getElementById('card').value;
         fetch('/api/orders', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ card: card })
         }).then(function (r) { return r.json(); }).then(function (data) {
           document.getElementById('status').textContent = data.declined
             ? 'Payment declined for order ' + data.id
             : 'Order confirmed: ' + data.id;
         });
       });`));
  },

  '/profile': (_req, res) => {
    send(res, 200, page('Profile', `
      <h1>Profile</h1>
      <p>Signed in as qa.agent@example.com</p>
      <button data-testid="delete-account">Delete account</button>`,
      `document.querySelector('[data-testid=delete-account]').addEventListener('click', function () {
         document.body.innerHTML = '<h1>Account deleted</h1>';
       });`));
  },

  '/api/inventory': (_req, res) => {
    // Defect 3.
    send(res, 500, JSON.stringify({ error: 'inventory service unavailable' }), 'application/json');
  },

  '/api/orders': (req, res) => {
    if (req.method !== 'POST') {
      send(res, 405, JSON.stringify({ error: 'method not allowed' }), 'application/json');
      return;
    }
    readBody(req, (body) => {
      const card = String((safeParse(body) as { card?: string }).card ?? '');
      // Defects 5 and 6: no idempotency key, and a declined card still books.
      const declined = card.endsWith('0002');
      const order: Order = { id: nextOrderId++, card: mask(card), declined };
      orders.push(order);
      send(res, 200, JSON.stringify({ id: order.id, declined, orders: orders.length }), 'application/json');
    });
  },

  '/api/orders/list': (_req, res) => {
    send(res, 200, JSON.stringify({ orders }), 'application/json');
  },
};

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = routes[url.pathname];
  if (route) {
    route(req, res, url);
    return;
  }
  // Defect 4: the Help link in the navigation lands here.
  send(res, 404, page('Not found', '<h1>404</h1><p>That page does not exist.</p>'));
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(body);
}

function readBody(req: IncomingMessage, done: (body: string) => void): void {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.on('end', () => done(data));
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function mask(card: string): string {
  return card.length > 4 ? `****${card.slice(-4)}` : '****';
}

const port = Number(process.env.PORT ?? 4321);
createServer(handler).listen(port, () => {
  process.stdout.write(`demo shop listening on http://localhost:${port}\n`);
});
